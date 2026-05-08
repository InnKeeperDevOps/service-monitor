# syntax=docker/dockerfile:1.7
# Build the kaiad-operator manager binary.
FROM golang:1.26 AS build
WORKDIR /workspace

# Copy go.mod / go.sum first to maximize layer caching.
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    go mod download

# Copy the rest of the source.
COPY api/ api/
COPY cmd/ cmd/
COPY internal/ internal/

# Static build, no cgo, stripped.
RUN --mount=type=cache,target=/root/.cache/go-build \
    --mount=type=cache,target=/go/pkg/mod \
    CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /out/manager ./cmd/manager

FROM gcr.io/distroless/static:nonroot
WORKDIR /
COPY --from=build /out/manager /manager
USER 65532:65532
ENTRYPOINT ["/manager"]
