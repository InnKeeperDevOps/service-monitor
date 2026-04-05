export type DetectorMatch = {
  matched: boolean;
  severity: "low" | "medium" | "high" | "critical";
  confidence: number;
  pattern: string;
  excerpt: string;
};

export type LogDetector = {
  id: string;
  name: string;
  detect(message: string): DetectorMatch | null;
};

function firstMatch(message: string, pattern: RegExp): string {
  const m = message.match(pattern);
  return m ? m[0] : "";
}

export const javaExceptionDetector: LogDetector = {
  id: "java-exception",
  name: "Java Exception Detector",
  detect(message) {
    const pattern = /Exception|at com\.|at java\.|at org\./;
    if (!pattern.test(message)) return null;
    return {
      matched: true,
      severity: "high",
      confidence: 0.9,
      pattern: pattern.source,
      excerpt: firstMatch(message, pattern),
    };
  },
};

export const nodeErrorDetector: LogDetector = {
  id: "nodejs_exception",
  name: "Node.js Exception Detector",
  detect(message) {
    const tracePattern =
      /UnhandledPromiseRejection|at Object\.<anonymous>|at Module\._compile|at node:/;
    if (tracePattern.test(message)) {
      return {
        matched: true,
        severity: "high",
        confidence: 0.95,
        pattern: tracePattern.source,
        excerpt: firstMatch(message, tracePattern),
      };
    }
    const keywordPattern =
      /TypeError:|ReferenceError:|SyntaxError:|RangeError:/;
    if (keywordPattern.test(message)) {
      return {
        matched: true,
        severity: "high",
        confidence: 0.8,
        pattern: keywordPattern.source,
        excerpt: firstMatch(message, keywordPattern),
      };
    }
    return null;
  },
};

export const pythonTracebackDetector: LogDetector = {
  id: "python_traceback",
  name: "Python Traceback Detector",
  detect(message) {
    const tracePattern =
      /Traceback \(most recent call last\)|File ".*", line \d+/;
    if (tracePattern.test(message)) {
      return {
        matched: true,
        severity: "high",
        confidence: 0.95,
        pattern: tracePattern.source,
        excerpt: firstMatch(message, tracePattern),
      };
    }
    const exceptionPattern =
      /ValueError|KeyError|ImportError|AttributeError|RuntimeError/;
    if (exceptionPattern.test(message)) {
      return {
        matched: true,
        severity: "high",
        confidence: 0.75,
        pattern: exceptionPattern.source,
        excerpt: firstMatch(message, exceptionPattern),
      };
    }
    return null;
  },
};

export const phpErrorDetector: LogDetector = {
  id: "php_error",
  name: "PHP Error Detector",
  detect(message) {
    const strongPattern = /Fatal error:|Parse error:|thrown in \//;
    if (strongPattern.test(message)) {
      return {
        matched: true,
        severity: "high",
        confidence: 0.9,
        pattern: strongPattern.source,
        excerpt: firstMatch(message, strongPattern),
      };
    }
    const keywordPattern =
      /Warning:|#\d+ |Uncaught Exception|PHP Fatal error|PHP Warning/;
    if (keywordPattern.test(message)) {
      return {
        matched: true,
        severity: "medium",
        confidence: 0.7,
        pattern: keywordPattern.source,
        excerpt: firstMatch(message, keywordPattern),
      };
    }
    return null;
  },
};

export const genericErrorDetector: LogDetector = {
  id: "generic_fatal",
  name: "Generic Fatal Detector",
  detect(message) {
    const strongPattern = /OutOfMemoryError|StackOverflowError|SEGFAULT|PANIC/;
    if (strongPattern.test(message)) {
      return {
        matched: true,
        severity: "critical",
        confidence: 0.9,
        pattern: strongPattern.source,
        excerpt: firstMatch(message, strongPattern),
      };
    }
    const keywordPattern = /\b(ERROR|FATAL|CRITICAL)\b/i;
    if (keywordPattern.test(message)) {
      return {
        matched: true,
        severity: "medium",
        confidence: 0.6,
        pattern: keywordPattern.source,
        excerpt: firstMatch(message, keywordPattern),
      };
    }
    return null;
  },
};

export const BUILT_IN_DETECTORS: LogDetector[] = [
  javaExceptionDetector,
  nodeErrorDetector,
  pythonTracebackDetector,
  genericErrorDetector,
  phpErrorDetector,
];

export function createRegexDetector(
  id: string,
  name: string,
  pattern: RegExp,
  severity: DetectorMatch["severity"],
  confidence: number,
): LogDetector {
  return {
    id,
    name,
    detect(message) {
      if (!pattern.test(message)) return null;
      return {
        matched: true,
        severity,
        confidence,
        pattern: pattern.source,
        excerpt: firstMatch(message, pattern),
      };
    },
  };
}

export function createUserDefinedDetector(
  id: string,
  pattern: string,
  label: string,
  confidence: number = 0.8,
): LogDetector {
  let regex: RegExp | null;
  try {
    regex = new RegExp(pattern);
  } catch {
    regex = null;
  }
  return {
    id,
    name: label,
    detect(message) {
      if (!regex || !regex.test(message)) return null;
      return {
        matched: true,
        severity: "medium",
        confidence,
        pattern,
        excerpt: regex ? firstMatch(message, regex) : "",
      };
    },
  };
}

export function runDetectors(
  message: string,
  detectors: LogDetector[],
): DetectorMatch[] {
  const matches: DetectorMatch[] = [];
  for (const detector of detectors) {
    const result = detector.detect(message);
    if (result) matches.push(result);
  }
  return matches.sort((a, b) => b.confidence - a.confidence);
}
