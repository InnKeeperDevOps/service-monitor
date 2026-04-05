import { describe, it, expect } from "vitest";
import {
  javaExceptionDetector,
  nodeErrorDetector,
  pythonTracebackDetector,
  genericErrorDetector,
  phpErrorDetector,
  createRegexDetector,
  createUserDefinedDetector,
  runDetectors,
  BUILT_IN_DETECTORS,
} from "../src/index.js";

describe("javaExceptionDetector", () => {
  it("matches a Java exception message", () => {
    const result = javaExceptionDetector.detect(
      "java.lang.NullPointerException at com.example.App.main(App.java:12)",
    );
    expect(result).not.toBeNull();
    expect(result!.matched).toBe(true);
    expect(result!.severity).toBe("high");
    expect(result!.confidence).toBe(0.9);
  });

  it("returns null for unrelated message", () => {
    expect(javaExceptionDetector.detect("all systems nominal")).toBeNull();
  });
});

describe("nodeErrorDetector", () => {
  it("matches UnhandledPromiseRejection with trace-level confidence", () => {
    const result = nodeErrorDetector.detect(
      "UnhandledPromiseRejection: connection refused",
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("high");
    expect(result!.confidence).toBe(0.95);
  });

  it("matches TypeError with keyword-level confidence", () => {
    const result = nodeErrorDetector.detect(
      "TypeError: Cannot read properties of undefined",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
  });

  it("matches SyntaxError", () => {
    const result = nodeErrorDetector.detect(
      "SyntaxError: Unexpected token '<'",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
  });

  it("matches RangeError", () => {
    const result = nodeErrorDetector.detect(
      "RangeError: Maximum call stack size exceeded",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
  });

  it("matches ReferenceError", () => {
    const result = nodeErrorDetector.detect(
      "ReferenceError: x is not defined",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
  });

  it("matches at Object.<anonymous> stack trace", () => {
    const result = nodeErrorDetector.detect(
      "    at Object.<anonymous> (/app/index.js:1:1)",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.95);
  });

  it("returns null for normal log lines", () => {
    expect(nodeErrorDetector.detect("GET /api/users 200 12ms")).toBeNull();
    expect(
      nodeErrorDetector.detect("Server listening on port 3000"),
    ).toBeNull();
  });
});

describe("pythonTracebackDetector", () => {
  it("matches a Python traceback with trace-level confidence", () => {
    const result = pythonTracebackDetector.detect(
      'Traceback (most recent call last):\n  File "app.py", line 10',
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("high");
    expect(result!.confidence).toBe(0.95);
  });

  it("matches File/line pattern", () => {
    const result = pythonTracebackDetector.detect(
      '  File "views.py", line 42, in handle_request',
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.95);
  });

  it("matches ValueError with keyword-level confidence", () => {
    const result = pythonTracebackDetector.detect(
      "ValueError: invalid literal for int()",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.75);
  });

  it("matches KeyError", () => {
    const result = pythonTracebackDetector.detect("KeyError: 'username'");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.75);
  });

  it("matches ImportError", () => {
    const result = pythonTracebackDetector.detect(
      "ImportError: No module named 'flask'",
    );
    expect(result).not.toBeNull();
  });

  it("matches AttributeError", () => {
    const result = pythonTracebackDetector.detect(
      "AttributeError: 'NoneType' object has no attribute 'id'",
    );
    expect(result).not.toBeNull();
  });

  it("matches RuntimeError", () => {
    const result = pythonTracebackDetector.detect(
      "RuntimeError: working outside of application context",
    );
    expect(result).not.toBeNull();
  });

  it("returns null for normal Python output", () => {
    expect(
      pythonTracebackDetector.detect("INFO: Application startup complete"),
    ).toBeNull();
    expect(
      pythonTracebackDetector.detect("Processing 150 records"),
    ).toBeNull();
  });
});

describe("phpErrorDetector", () => {
  it("matches Fatal error with high confidence", () => {
    const result = phpErrorDetector.detect(
      "Fatal error: Allowed memory size of 134217728 bytes exhausted",
    );
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("high");
    expect(result!.confidence).toBe(0.9);
  });

  it("matches Parse error", () => {
    const result = phpErrorDetector.detect(
      "Parse error: syntax error, unexpected '}' in /var/www/index.php on line 42",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("matches thrown in / pattern", () => {
    const result = phpErrorDetector.detect(
      "thrown in /var/www/html/app.php on line 55",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("matches PHP stack trace with #0", () => {
    const result = phpErrorDetector.detect(
      "#0 /var/www/html/index.php(42): App->run()",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.7);
  });

  it("matches Warning", () => {
    const result = phpErrorDetector.detect(
      "Warning: file_get_contents(): failed to open stream",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.7);
  });

  it("matches PHP Fatal error (legacy format)", () => {
    const result = phpErrorDetector.detect(
      "PHP Fatal error: Uncaught Error in /var/www/app.php:10",
    );
    expect(result).not.toBeNull();
  });

  it("matches Uncaught Exception", () => {
    const result = phpErrorDetector.detect(
      "Uncaught Exception: Invalid argument",
    );
    expect(result).not.toBeNull();
  });

  it("returns null for normal PHP output", () => {
    expect(
      phpErrorDetector.detect("[2026-04-04] Request completed 200"),
    ).toBeNull();
    expect(
      phpErrorDetector.detect("Cache hit for key user_123"),
    ).toBeNull();
  });
});

describe("genericErrorDetector", () => {
  it("matches ERROR keyword with keyword-level confidence", () => {
    const result = genericErrorDetector.detect("ERROR: disk full");
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("medium");
    expect(result!.confidence).toBe(0.6);
  });

  it("matches FATAL keyword", () => {
    const result = genericErrorDetector.detect("FATAL: out of memory");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.6);
  });

  it("matches CRITICAL keyword", () => {
    const result = genericErrorDetector.detect(
      "CRITICAL: database unreachable",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.6);
  });

  it("matches PANIC with high confidence", () => {
    const result = genericErrorDetector.detect("kernel PANIC - not syncing");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
    expect(result!.severity).toBe("critical");
  });

  it("matches SEGFAULT with high confidence", () => {
    const result = genericErrorDetector.detect("SEGFAULT at address 0x0000");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("matches OutOfMemoryError with high confidence", () => {
    const result = genericErrorDetector.detect(
      "java.lang.OutOfMemoryError: Java heap space",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
    expect(result!.severity).toBe("critical");
  });

  it("matches StackOverflowError with high confidence", () => {
    const result = genericErrorDetector.detect(
      "java.lang.StackOverflowError",
    );
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.9);
  });

  it("returns null for non-error messages", () => {
    expect(genericErrorDetector.detect("INFO: healthy")).toBeNull();
    expect(genericErrorDetector.detect("DEBUG: processing request")).toBeNull();
  });
});

describe("createRegexDetector", () => {
  it("creates a working custom detector", () => {
    const detector = createRegexDetector(
      "oom-killer",
      "OOM Killer",
      /Out of memory: Kill process/,
      "critical",
      0.95,
    );
    const result = detector.detect("Out of memory: Kill process 1234 (java)");
    expect(result).not.toBeNull();
    expect(result!.severity).toBe("critical");
    expect(result!.confidence).toBe(0.95);
  });

  it("returns null when pattern does not match", () => {
    const detector = createRegexDetector(
      "custom",
      "Custom",
      /SEGFAULT/,
      "high",
      0.8,
    );
    expect(detector.detect("INFO: healthy")).toBeNull();
  });
});

describe("createUserDefinedDetector", () => {
  it("creates a detector from a valid regex string", () => {
    const detector = createUserDefinedDetector(
      "custom-timeout",
      "request timed? ?out",
      "Timeout Detector",
      0.85,
    );
    const result = detector.detect("ERROR: request timed out after 30s");
    expect(result).not.toBeNull();
    expect(result!.matched).toBe(true);
    expect(result!.confidence).toBe(0.85);
  });

  it("uses default confidence when not specified", () => {
    const detector = createUserDefinedDetector(
      "custom-oom",
      "out of memory",
      "OOM Detector",
    );
    const result = detector.detect("process killed: out of memory");
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.8);
  });

  it("returns null for non-matching messages", () => {
    const detector = createUserDefinedDetector(
      "custom",
      "DEADLOCK",
      "Deadlock Detector",
    );
    expect(detector.detect("INFO: all good")).toBeNull();
  });

  it("handles invalid regex gracefully (never matches)", () => {
    const detector = createUserDefinedDetector(
      "bad-regex",
      "[invalid((",
      "Bad Regex Detector",
    );
    expect(detector.detect("[invalid((")).toBeNull();
    expect(detector.detect("anything at all")).toBeNull();
  });
});

describe("runDetectors", () => {
  it("returns matches sorted by confidence DESC", () => {
    const message =
      "ERROR: java.lang.NullPointerException at com.example.App.main";
    const matches = runDetectors(message, BUILT_IN_DETECTORS);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < matches.length; i++) {
      expect(matches[i - 1].confidence).toBeGreaterThanOrEqual(
        matches[i].confidence,
      );
    }
  });

  it("returns empty array for non-matching message", () => {
    const matches = runDetectors("INFO: healthy", BUILT_IN_DETECTORS);
    expect(matches).toEqual([]);
  });

  it("non-error message matches none of the built-in detectors", () => {
    const matches = runDetectors(
      "2026-04-04 INFO: all services healthy",
      BUILT_IN_DETECTORS,
    );
    expect(matches).toHaveLength(0);
  });
});
