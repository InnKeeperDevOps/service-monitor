package controller

import (
	"context"
	"errors"
	"fmt"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
	"github.com/innkeeperdevops/kaiad/operator/internal/kaiad"
)

// bootstrapTokenTTLSeconds is how long a freshly minted enrollment token is
// valid for. The agent only consumes it once, on first connection, so a short
// window is plenty and limits the blast radius if the Secret leaks.
const bootstrapTokenTTLSeconds = 5 * 60

// mintedAtAnnotation is set on Secrets the operator owns. The annotation lets
// us tell our auto-minted Secrets apart from user-provided ones (no
// annotation) and detect stale tokens that need to be re-minted.
const mintedAtAnnotation = "kaiad.dev/minted-at"

// staleAfter is the age past which a token we minted is presumed unusable —
// either consumed by an earlier agent enrollment or expired. Set slightly
// longer than bootstrapTokenTTLSeconds to absorb clock skew + slow pods, but
// short enough that a stuck pod (e.g. spent token after a pod replacement)
// is corrected on the next reconcile within minutes.
var staleAfter = (bootstrapTokenTTLSeconds + 60) * time.Second

// resolveEnrollmentToken returns the bearer the agent pod should use, creating
// or refreshing the backing Secret if the CR opted into auto-mint and the
// existing Secret is empty. Returns the (Secret name, key) the Deployment env
// should reference and a transient ResolutionResult describing what changed
// for status reporting.
type EnrollmentResolution struct {
	SecretName     string
	SecretKey      string
	Minted         bool   // true if the operator just minted a fresh token via the API
	FutureAgentID  string // populated when the API minted a token and reserved an agent id
}

func resolveEnrollment(
	ctx context.Context,
	r client.Client,
	kaiadClient *kaiad.Client,
	agent *kaiadv1alpha1.KaiadAgent,
) (*EnrollmentResolution, error) {
	logger := ctrl.LoggerFrom(ctx)

	secretName, secretKey := defaultEnrollmentSecretName(agent), "token"
	if agent.Spec.Enrollment.SecretRef != nil {
		secretName = agent.Spec.Enrollment.SecretRef.Name
		if agent.Spec.Enrollment.SecretRef.Key != "" {
			secretKey = agent.Spec.Enrollment.SecretRef.Key
		}
	}

	// Already populated → nothing to do, unless we minted the token ourselves
	// and it's now stale (consumed by an earlier pod or past TTL). Stale
	// detection is the difference between "agent boot is recovering" and
	// "agent will hang forever holding a spent token" after a pod replacement
	// drops the persisted credential in the emptyDir volume.
	existing := &corev1.Secret{}
	err := r.Get(ctx, types.NamespacedName{Name: secretName, Namespace: agent.Namespace}, existing)
	switch {
	case err == nil:
		if data := existing.Data[secretKey]; len(data) > 0 {
			if isStaleOperatorMintedToken(existing, agent) {
				if err := clearStaleSecret(ctx, r, existing, secretKey); err != nil {
					return nil, fmt.Errorf("clear stale enrollment secret: %w", err)
				}
				ctrl.LoggerFrom(ctx).Info("enrollment secret was stale; cleared for re-mint",
					"secret", secretName, "mintedAt", existing.Annotations[mintedAtAnnotation])
				// Fall through to the mint path below.
			} else {
				return &EnrollmentResolution{SecretName: secretName, SecretKey: secretKey}, nil
			}
		}
		// Secret exists but empty. Fall through to mint if auto-mint is on,
		// otherwise surface a clear error to status.
	case apierrors.IsNotFound(err):
		// Will create below.
	default:
		return nil, fmt.Errorf("get enrollment secret: %w", err)
	}

	if !agent.Spec.Enrollment.AutoMint {
		return nil, fmt.Errorf("enrollment secret %q has no value at key %q and autoMint is false", secretName, secretKey)
	}

	// Mint via Kaiad API.
	tok, err := kaiadClient.MintEnrollmentToken(ctx, bootstrapTokenTTLSeconds)
	if err != nil {
		return nil, fmt.Errorf("mint enrollment token: %w", err)
	}

	// Upsert the Secret. Owner-ref points at the CR so deleting the CR
	// garbage-collects the bootstrap token. The minted-at annotation lets
	// later reconciles detect stale tokens we own and re-mint.
	desired := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name:      secretName,
			Namespace: agent.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/managed-by": "kaiad-operator",
				"kaiad.dev/agent":              agent.Name,
			},
			Annotations: map[string]string{
				mintedAtAnnotation: time.Now().UTC().Format(time.RFC3339),
			},
			OwnerReferences: []metav1.OwnerReference{ownerReferenceFor(agent)},
		},
		Type: corev1.SecretTypeOpaque,
		Data: map[string][]byte{secretKey: []byte(tok.Token)},
	}

	if apierrors.IsNotFound(err) || existing.Name == "" {
		if err := r.Create(ctx, desired); err != nil && !apierrors.IsAlreadyExists(err) {
			return nil, fmt.Errorf("create enrollment secret: %w", err)
		}
	} else {
		existing.Data = desired.Data
		if existing.Annotations == nil {
			existing.Annotations = map[string]string{}
		}
		existing.Annotations[mintedAtAnnotation] = desired.Annotations[mintedAtAnnotation]
		// Ensure operator owns the Secret going forward; do not clobber other refs.
		if !hasOwnerReference(existing.OwnerReferences, agent.UID) {
			existing.OwnerReferences = append(existing.OwnerReferences, ownerReferenceFor(agent))
		}
		if err := r.Update(ctx, existing); err != nil {
			return nil, fmt.Errorf("update enrollment secret: %w", err)
		}
	}

	logger.Info("minted enrollment token", "secret", secretName, "agentId", tok.AgentID, "ttlSeconds", bootstrapTokenTTLSeconds)
	return &EnrollmentResolution{
		SecretName:    secretName,
		SecretKey:     secretKey,
		Minted:        true,
		FutureAgentID: tok.AgentID,
	}, nil
}

// clearBootstrapSecret blanks the bootstrap token after the agent has
// successfully enrolled and persisted its credential. The pod no longer needs
// the Secret value and the agent's persistent credential takes over.
func clearBootstrapSecret(ctx context.Context, r client.Client, agent *kaiadv1alpha1.KaiadAgent, secretName, secretKey string) error {
	if !agent.Spec.Enrollment.AutoMint {
		// We don't own user-provided Secrets — leave them alone.
		return nil
	}
	existing := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Name: secretName, Namespace: agent.Namespace}, existing); err != nil {
		if apierrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	if existing.Data == nil || len(existing.Data[secretKey]) == 0 {
		return nil // already cleared
	}
	existing.Data[secretKey] = []byte{}
	if err := r.Update(ctx, existing); err != nil {
		return fmt.Errorf("clear enrollment secret: %w", err)
	}
	return nil
}

func defaultEnrollmentSecretName(agent *kaiadv1alpha1.KaiadAgent) string {
	return fmt.Sprintf("%s-enrollment", agent.Name)
}

func ownerReferenceFor(agent *kaiadv1alpha1.KaiadAgent) metav1.OwnerReference {
	t := true
	return metav1.OwnerReference{
		APIVersion:         kaiadv1alpha1.GroupVersion.String(),
		Kind:               "KaiadAgent",
		Name:               agent.Name,
		UID:                agent.UID,
		Controller:         &t,
		BlockOwnerDeletion: &t,
	}
}

func hasOwnerReference(refs []metav1.OwnerReference, uid types.UID) bool {
	for _, r := range refs {
		if r.UID == uid {
			return true
		}
	}
	return false
}

// Sentinel for callers that want to retry: missing Secret without auto-mint.
var ErrEnrollmentSecretEmpty = errors.New("enrollment secret is empty and autoMint is false")

// isStaleOperatorMintedToken reports whether the operator should consider an
// existing Secret's token spent and re-mint. Conservative: only "ours"
// (annotated with mintedAtAnnotation) and only past staleAfter. User-provided
// Secrets without the annotation are left alone — we don't have permission
// to know whether the user's token is fresh.
func isStaleOperatorMintedToken(secret *corev1.Secret, agent *kaiadv1alpha1.KaiadAgent) bool {
	if !agent.Spec.Enrollment.AutoMint {
		return false
	}
	raw, ok := secret.Annotations[mintedAtAnnotation]
	if !ok || raw == "" {
		return false
	}
	mintedAt, err := time.Parse(time.RFC3339, raw)
	if err != nil {
		// Annotation present but unparseable. Treat as stale so we recover
		// rather than relying on a malformed timestamp forever.
		return true
	}
	return time.Since(mintedAt) > staleAfter
}

// clearStaleSecret blanks the token data on a stale operator-minted Secret so
// the next reconcile loop mints fresh. Doesn't delete the Secret itself —
// keeping it preserves owner refs and labels.
func clearStaleSecret(ctx context.Context, r client.Client, secret *corev1.Secret, secretKey string) error {
	if secret.Data == nil {
		return nil
	}
	secret.Data[secretKey] = []byte{}
	// Clearing the annotation prevents a fast-loop retry if the API mint
	// fails — the next reconcile sees an empty Secret and falls into the
	// normal mint path with its own backoff.
	delete(secret.Annotations, mintedAtAnnotation)
	return r.Update(ctx, secret)
}
