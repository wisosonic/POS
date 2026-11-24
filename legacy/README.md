# Legacy (the old Darwish system's data and tools)

Not part of any project, and not used by the new system for a fresh customer. Kept for Darwish, in case it ever migrates.

- `POSDB.sql` (the old SQL Server dump, 157 MB, plaintext passwords inside: never print or commit it), `Uploads/` (the old product pictures) and `data/` (an old local database) are local files and are ignored by git.
- The import tools still live inside `branch-server` (`src/etl`, `src/cli/rehearse.ts`, `tests/migration`) and are to move here later.
