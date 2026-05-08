# Operator build / dev tasks. The implementation tracks the kubebuilder
# convention but is hand-rolled — there's no `kubebuilder init` artifact here.

GO        ?= go
IMG       ?= kaiad-operator:dev
KIND_NAME ?= kaiad-op-dev

CONTROLLER_GEN ?= $(GO) tool sigs.k8s.io/controller-tools/cmd/controller-gen

.PHONY: build
build: ## Compile the manager binary into bin/.
	$(GO) build -o bin/manager ./cmd/manager

.PHONY: test
test: ## Run unit tests.
	$(GO) test ./...

.PHONY: vet
vet:
	$(GO) vet ./...

.PHONY: docker-build
docker-build: ## Build the operator container image.
	docker build -t $(IMG) .

.PHONY: kind-load
kind-load: docker-build ## Load the operator image into a local kind cluster.
	kind load docker-image $(IMG) --name $(KIND_NAME)

.PHONY: manifests
manifests: ## Regenerate CRDs and RBAC manifests under config/.
	@if ! command -v controller-gen >/dev/null 2>&1; then \
		echo "controller-gen not on PATH; install via: go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest"; \
		exit 1; \
	fi
	controller-gen rbac:roleName=kaiad-operator-role crd webhook \
		paths="./api/...;./internal/controller/..." \
		output:crd:artifacts:config=config/crd/bases \
		output:rbac:artifacts:config=config/rbac

.PHONY: generate
generate: ## Regenerate deepcopy methods.
	@if ! command -v controller-gen >/dev/null 2>&1; then \
		echo "controller-gen not on PATH; install via: go install sigs.k8s.io/controller-tools/cmd/controller-gen@latest"; \
		exit 1; \
	fi
	controller-gen object:headerFile="" paths="./api/..."

.PHONY: tidy
tidy:
	$(GO) mod tidy

.PHONY: clean
clean:
	rm -rf bin/
