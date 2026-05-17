package docker

import (
	"bytes"
	"testing"
)

func TestSplitImageRef(t *testing.T) {
	cases := []struct{ ref, img, tag string }{
		{"panel.dev.kaiad.dev/svc:abc123", "panel.dev.kaiad.dev/svc", "abc123"},
		{"registry:5000/team/svc:v1", "registry:5000/team/svc", "v1"},
		{"plainname", "plainname", ""},
		{"host:5000/svc", "host:5000/svc", ""},
	}
	for _, c := range cases {
		img, tag := splitImageRef(c.ref)
		if img != c.img || tag != c.tag {
			t.Fatalf("splitImageRef(%q) = (%q,%q), want (%q,%q)", c.ref, img, tag, c.img, c.tag)
		}
	}
}

func TestStripDockerLogHeader(t *testing.T) {
	framed := append([]byte{0x01, 0, 0, 0, 0, 0, 0, 5}, []byte("hello")...)
	if got := stripDockerLogHeader(string(framed)); got != "hello" {
		t.Fatalf("strip framed = %q, want hello", got)
	}
	if got := stripDockerLogHeader("short"); got != "short" {
		t.Fatalf("strip short = %q", got)
	}
	plain := "plain text line without header bytes"
	if got := stripDockerLogHeader(plain); got != plain {
		t.Fatalf("strip plain = %q", got)
	}
}

func TestClassifyLogLevel(t *testing.T) {
	if classifyLogLevel("boom ERROR x") != "error" {
		t.Fatal("want error")
	}
	if classifyLogLevel("all good") != "info" {
		t.Fatal("want info")
	}
}

func TestReadMuxedStream(t *testing.T) {
	var in bytes.Buffer
	in.Write([]byte{0x01, 0, 0, 0, 0, 0, 0, 5})
	in.WriteString("hello")
	in.Write([]byte{0x02, 0, 0, 0, 0, 0, 0, 0}) // zero-size frame skipped
	in.Write([]byte{0x01, 0, 0, 0, 0, 0, 0, 3})
	in.WriteString("end")
	out, err := readMuxedStream(&in)
	if err != nil {
		t.Fatalf("readMuxedStream: %v", err)
	}
	if string(out) != "helloend" {
		t.Fatalf("readMuxedStream = %q, want helloend", string(out))
	}
}

func TestRegistryAuthHeaderValue(t *testing.T) {
	var nilAuth *RegistryAuth
	if v, err := nilAuth.headerValue(); err != nil || v != "" {
		t.Fatalf("nil headerValue = %q,%v", v, err)
	}
	a := &RegistryAuth{Username: "u", Password: "p", ServerAddress: "reg:5000"}
	v, err := a.headerValue()
	if err != nil || v == "" {
		t.Fatalf("headerValue = %q,%v", v, err)
	}
}
