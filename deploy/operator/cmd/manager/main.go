// Command manager is the entry point for the Kaiad agent operator.
//
// It runs a controller-runtime manager that reconciles KaiadAgent custom
// resources into agent Deployments, ServiceAccounts, and scoped RBAC objects
// (see deploy/operator/internal/controller). Configuration is read from env:
//
//	KAIAD_API_BASE_URL        Required. Base URL of the Kaiad API (e.g. https://panel.example.com).
//	KAIAD_API_CREDENTIAL      Required. Operator bearer token (created via POST /api/v1/admin/api-credentials).
//	KAIAD_OPERATOR_NAMESPACE  Optional. Defaults to the pod's downward-API namespace; used for leader election scope.
//	METRICS_BIND_ADDRESS      Optional. Defaults to ":8080".
//	HEALTH_PROBE_BIND_ADDRESS Optional. Defaults to ":8081".
package main

import (
	"flag"
	"os"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	kaiadv1alpha1 "github.com/innkeeperdevops/kaiad/operator/api/v1alpha1"
	"github.com/innkeeperdevops/kaiad/operator/internal/controller"
	"github.com/innkeeperdevops/kaiad/operator/internal/kaiad"
)

var (
	scheme = runtime.NewScheme()
)

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(kaiadv1alpha1.AddToScheme(scheme))
}

func main() {
	var (
		metricsAddr          string
		probeAddr            string
		enableLeaderElection bool
	)
	flag.StringVar(&metricsAddr, "metrics-bind-address", envOr("METRICS_BIND_ADDRESS", ":8080"), "address the metric endpoint binds to")
	flag.StringVar(&probeAddr, "health-probe-bind-address", envOr("HEALTH_PROBE_BIND_ADDRESS", ":8081"), "address the probe endpoint binds to")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "enable leader election")
	opts := zap.Options{Development: false}
	opts.BindFlags(flag.CommandLine)
	flag.Parse()

	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&opts)))
	logger := ctrl.Log.WithName("kaiad-operator")

	apiBase := os.Getenv("KAIAD_API_BASE_URL")
	apiCred := os.Getenv("KAIAD_API_CREDENTIAL")
	if apiBase == "" || apiCred == "" {
		logger.Error(nil, "KAIAD_API_BASE_URL and KAIAD_API_CREDENTIAL are required")
		os.Exit(1)
	}

	leaderElectionNS := envOr("KAIAD_OPERATOR_NAMESPACE", "")

	mgr, err := ctrl.NewManager(ctrl.GetConfigOrDie(), ctrl.Options{
		Scheme:                  scheme,
		Metrics:                 metricsserver.Options{BindAddress: metricsAddr},
		HealthProbeBindAddress:  probeAddr,
		LeaderElection:          enableLeaderElection,
		LeaderElectionID:        "kaiad-operator-leader.kaiad.dev",
		LeaderElectionNamespace: leaderElectionNS,
	})
	if err != nil {
		logger.Error(err, "unable to start manager")
		os.Exit(1)
	}

	kaiadClient := kaiad.NewClient(apiBase, apiCred)

	if err := (&controller.KaiadAgentReconciler{
		Client:      mgr.GetClient(),
		Scheme:      mgr.GetScheme(),
		KaiadClient: kaiadClient,
	}).SetupWithManager(mgr); err != nil {
		logger.Error(err, "unable to create KaiadAgent controller")
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		logger.Error(err, "unable to set up health check")
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		logger.Error(err, "unable to set up ready check")
		os.Exit(1)
	}

	logger.Info("starting manager", "metrics", metricsAddr, "probes", probeAddr, "kaiadAPI", apiBase)
	if err := mgr.Start(ctrl.SetupSignalHandler()); err != nil {
		logger.Error(err, "manager exited with error")
		os.Exit(1)
	}
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}
