# sandbox/

`isolated-vm` runner for `search(code)` and `execute(code)`: a fresh isolate per call, frozen binding
namespaces, JSON-only boundary, a wall-clock budget that bindings pause while waiting on human approval,
and memory/result/log caps. Node must run with `--no-node-snapshot`.

Design: [`docs/design/05-call-path.md`](../../../../docs/design/05-call-path.md) §5.4.
