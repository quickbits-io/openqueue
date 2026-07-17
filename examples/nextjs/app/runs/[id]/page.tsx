import { openqueue } from '../../../lib/client';

export const dynamic = 'force-dynamic';

export default async function RunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const run = await openqueue.runs.retrieve(id);

  return (
    <main>
      <h1>Run {id}</h1>
      {run ? (
        <dl>
          <dt>Task</dt>
          <dd>{run.task}</dd>
          <dt>Status</dt>
          <dd>{run.status}</dd>
          <dt>Output</dt>
          <dd>
            <pre>{JSON.stringify(run.output, null, 2)}</pre>
          </dd>
        </dl>
      ) : (
        <p>Run not found (yet).</p>
      )}
      <p>
        <a href={`/runs/${id}`}>Refresh</a> · <a href="/">Home</a>
      </p>
    </main>
  );
}
