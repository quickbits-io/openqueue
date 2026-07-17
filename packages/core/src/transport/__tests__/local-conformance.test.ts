import { describeTransportConformance } from '../conformance';
import { createLocalTransport } from '../local';

// Ungated: the in-memory transport runs the full conformance suite with no
// external services, so default CI finally exercises every scenario.
describeTransportConformance({
  name: 'local',
  create: () => createLocalTransport(),
  timing: { settleMs: 2000, delayMs: 250 },
});
