// Test-owned gate triggers a real SDK autonomous run, never a host prompt replay.
import { writeFile, access, unlink } from 'node:fs/promises';
import { join } from 'node:path';
export default function (pi) {
  let serial = 0;
  const timers = new Set();
  pi.registerTool({
    name: 'p6_arm_autonomous',
    label: 'P6 arm background',
    description:
      'P6 acceptance only: arm one gate-controlled independent background turn after this foreground turn completes.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_id, _args, _signal, _update, ctx) {
      const n = ++serial;
      await writeFile(join(ctx.cwd, `p6-auto-armed-${n}`), 'ARMED\n', { flag: 'wx' });
      let firing = false;
      const timer = setInterval(async () => {
        if (firing || !ctx.isIdle()) return;
        const gate = join(ctx.cwd, `p6-auto-release-${n}`);
        try {
          await access(gate);
        } catch {
          return;
        }
        firing = true;
        clearInterval(timer);
        timers.delete(timer);
        await unlink(gate);
        pi.sendMessage(
          {
            customType: 'p6-autonomous-acceptance',
            display: true,
            content:
              'P6 independent background run. Call p6_permission_probe exactly once and wait for the real tool result. If authorized, reply with only the marker P6_AUTO_DONE, no punctuation. If cancelled, reply P6_AUTO_CANCELLED. Do not use other tools.',
          },
          { triggerTurn: true },
        );
      }, 50);
      timers.add(timer);
      return { content: [{ type: 'text', text: 'P6_AUTO_ARMED' }], details: { armed: n } };
    },
  });
  pi.on('session_shutdown', () => {
    for (const timer of timers) clearInterval(timer);
    timers.clear();
  });
}
