# @openqueue/cli

The `openqueue` command-line tool for
[OpenQueue](https://github.com/quickbits-io/openqueue) — scaffold, develop,
build, and run workers.

> **Bun-native.** The CLI runs on [Bun](https://bun.sh) (it uses Bun's bundler,
> process, and glob APIs) and runs your TypeScript task files directly.

```bash
bun add -d @openqueue/cli
```

## Commands

```bash
openqueue init     # scaffold worker.config.ts, a starter task, env, Dockerfile
openqueue add      # add a task (and optional persistence) to an existing project
openqueue dev      # discover tasks and run the worker + Workbench in watch mode
openqueue build    # compile the worker for production
openqueue start    # run the compiled worker
```

Once installed locally, `bunx openqueue <command>` resolves the binary from your
`node_modules`.

## Documentation

See the [OpenQueue docs](https://github.com/quickbits-io/openqueue/tree/main/site/content/docs).

## License

[MIT](https://github.com/quickbits-io/openqueue/blob/main/LICENSE)
