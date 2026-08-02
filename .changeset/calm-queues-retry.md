---
"@ventus-software-solutions/task-queue": patch
---

Keep retries idempotent while one retry is pending or current, and stop persisting
undeclared lifecycle fields on completed tasks.
