import { dispatchExample } from './actions';

export default function Page() {
  return (
    <main>
      <h1>OpenQueue × Next.js</h1>
      <p>
        Dispatch the `example` task on the running worker via a server action.
      </p>
      <form action={dispatchExample}>
        <input name="message" defaultValue="Hello from Next.js" />
        <button type="submit">Dispatch job</button>
      </form>
    </main>
  );
}
