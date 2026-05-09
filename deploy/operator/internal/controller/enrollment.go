package controller

import (
	"context"
	"errors"
	"fmt"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
)

// EnrollmentResolution names the Secret + key the agent Deployment should
// project as `SM_ENROLLMENT_TOKEN`. The operator does not own this Secret —
// the cluster admin pre-provisioned it with a token minted via the Kaiad
// panel UI.
type EnrollmentResolution struct {
	SecretName string
	SecretKey  string
}

// resolveEnrollment looks up the Secret named in spec.enrollment.secretRef
// and confirms it has a non-empty token at the expected key. Auto-minting
// was removed: it required an operator-side API credential that pinned the
// operator to a single tenant the CR couldn't name, and produced thousands
// of expired tokens because every reconcile minted anew.
func resolveEnrollment(
	ctx context.Context,
	r client.Client,
	agent *kaiadv1alpha1.KaiadAgent,
) (*EnrollmentResolution, error) {
	if agent.Spec.Enrollment.SecretRef == nil || agent.Spec.Enrollment.SecretRef.Name == "" {
		return nil, ErrEnrollmentSecretMissing
	}
	secretName := agent.Spec.Enrollment.SecretRef.Name
	secretKey := agent.Spec.Enrollment.SecretRef.Key
	if secretKey == "" {
		secretKey = "token"
	}

	existing := &corev1.Secret{}
	if err := r.Get(ctx, types.NamespacedName{Name: secretName, Namespace: agent.Namespace}, existing); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, fmt.Errorf("%w: %s/%s", ErrEnrollmentSecretMissing, agent.Namespace, secretName)
		}
		return nil, fmt.Errorf("get enrollment secret: %w", err)
	}
	if len(existing.Data[secretKey]) == 0 {
		return nil, fmt.Errorf("%w: %s/%s key=%q", ErrEnrollmentSecretEmpty, agent.Namespace, secretName, secretKey)
	}

	return &EnrollmentResolution{SecretName: secretName, SecretKey: secretKey}, nil
}

// ErrEnrollmentSecretMissing is the sentinel returned when spec.enrollment.secretRef
// points at a Secret that does not exist in the agent's namespace. The
// operator surfaces it as `EnrollmentValid=False, Reason=SecretMissing`.
var ErrEnrollmentSecretMissing = errors.New("enrollment secret not found")

// ErrEnrollmentSecretEmpty is the sentinel returned when the named Secret
// exists but the expected key is empty / absent.
var ErrEnrollmentSecretEmpty = errors.New("enrollment secret has no value at the expected key")
