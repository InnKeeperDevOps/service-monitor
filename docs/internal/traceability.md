---
title: Requirements Traceability
---

# Requirements → Test ID Matrix

| Requirement | Test ID | Status |
|---|---|---|
| Tenant A cannot read tenant B resources | T-SEC-001 | ✅ Automated |
| Invalid HMAC webhook rejected, no enqueue | T-SEC-002 | ✅ Automated |
| httpRequest to private IP blocked | T-SEC-003 | ✅ Automated |
| httpRequest redirect to private IP blocked | T-SEC-004 | ✅ Documented |
| Fork+join graph: join sees merged context | T-WF-001 | ✅ Automated |
| Parallel branch failure: spec-defined aggregation | T-WF-002 | ✅ Automated |
| Duplicate command_id: single side effect | T-AG-001 | 📋 Manual checklist |
| Merge not allowlisted: deny, no GitHub call | T-GH-001 | ✅ Automated |
| Allowlisted bot PR: success + audit | T-GH-002 | ✅ Automated |
