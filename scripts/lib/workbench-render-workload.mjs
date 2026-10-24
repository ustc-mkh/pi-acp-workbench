// Shared production-bundle display workload; injected deltas never dispatch provider prompts.
export function measureRenderWorkload(page, snapshot) {
  return page.evaluate(async (snapshot) => {
    performance.clearMeasures('workbench.render');
    performance.clearMeasures('workbench.markdown');
    const longTasks = [];
    const observer = new PerformanceObserver((list) =>
      longTasks.push(...list.getEntries().map((entry) => entry.duration)),
    );
    observer.observe({ type: 'longtask', buffered: false });
    const state = {
      ...snapshot,
      selected: snapshot.selected,
      operations: [],
      view: {
        ...snapshot.view,
        entries: [],
        tools: [],
        earlier: undefined,
        historical: false,
        view: {
          ...snapshot.view.view,
          active_turn: 'perf-turn',
          status: 'Running',
          pending_interactions: {},
          catalogue: {
            ...snapshot.view.view.catalogue,
            commands: [
              { name: 'review', description: 'Review', input_hint: null },
              { name: 'reset', description: 'Reset', input_hint: null },
            ],
          },
        },
      },
    };
    const rows = [
      {
        seq: 1,
        id: 'perf-user',
        turn: 'perf-turn',
        role: 'User',
        message: null,
        image: null,
        text: { Inline: { text: 'Selection stays readable' } },
      },
    ];
    const frame = () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    let sequence = Date.now() * 1000;
    const update = () =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'state',
            sequence: ++sequence,
            state: { ...state, view: { ...state.view, entries: [...rows] } },
          },
        }),
      );
    update();
    await frame();
    const first = document.querySelector('article');
    const input = document.querySelector('#prompt');
    input.focus();
    const range = document.createRange();
    range.selectNodeContents(first.querySelector('p'));
    getSelection().removeAllRanges();
    getSelection().addRange(range);
    const inputTimes = [],
      inputToFrame = [];
    for (let i = 0; i < 1000; i++) {
      rows.push({
        seq: i + 2,
        id: `perf-${i}`,
        turn: 'perf-turn',
        role: 'Agent',
        message: 'perf-message',
        image: null,
        text: {
          Inline: {
            text:
              i === 0
                ? '```ts\n'
                : i === 999
                  ? '\n```\n\n[External](https://例子.测试/path)'
                  : `// fragment ${i}\n`,
          },
        },
      });
      update();
      if (i % 10 === 9) {
        await frame();
        if (
          document.activeElement !== input ||
          first !== document.querySelector('article') ||
          getSelection().toString() !== 'Selection stays readable'
        )
          throw new Error(
            `Streaming lost focus/selection/message identity at ${i}: focus=${document.activeElement === input}, identity=${first === document.querySelector('article')}, selection=${getSelection().toString()}`,
          );
        const start = performance.now();
        input.value = `draft ${i}`;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        inputTimes.push(performance.now() - start);
        await new Promise((done) => requestAnimationFrame(done));
        inputToFrame.push(performance.now() - start);
        // Native textarea edits legitimately clear the document selection. Select
        // again and check it survives the next render, not the unrelated edit.
        getSelection().removeAllRanges();
        getSelection().addRange(range);
      }
    }
    state.view.view.active_turn = null;
    state.view.view.status = 'Idle';
    update();
    await frame();
    observer.disconnect();
    const distribution = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      const at = (p) => sorted[Math.ceil(sorted.length * p) - 1] ?? 0;
      return {
        count: values.length,
        median: at(0.5),
        p95: at(0.95),
        p99: at(0.99),
        max: sorted.at(-1) ?? 0,
        samples_ms: values,
      };
    };
    return {
      render: distribution(
        performance.getEntriesByName('workbench.render').map((entry) => entry.duration),
      ),
      markdown: distribution(
        performance.getEntriesByName('workbench.markdown').map((entry) => entry.duration),
      ),
      input: distribution(inputTimes),
      inputToFrame: distribution(inputToFrame),
      longTasks: distribution(longTasks),
      messages: document.querySelectorAll('article').length,
      code: document.querySelector('article.agent code')?.textContent.includes('fragment 998'),
    };
  }, snapshot);
}
