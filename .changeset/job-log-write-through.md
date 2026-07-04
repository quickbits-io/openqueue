---
'@openqueue/core': patch
---

Stream job logs write-through: each console line is written as soon as the previous write settles, in emit order, and nothing is dropped. The previous implementation retained a promise per line for the entire run, growing without bound on long-running jobs.
