---
'@ventus_software/task-queue': minor
---

Initial release. File-based stateless-façade task queue with pluggable storage.

- TaskQueue with enqueue / claimNext / completeCurrent / peek
- Storage interface (read / write / withLock) decoupled from queue logic
- FileStorage shipped (atomic temp-file writes + proper-lockfile)
- Public Task type clean of agent-specific fields; metadata slot for extension

Extracted from AIDE (https://github.com/ventus-software-solutions/about-aide).

