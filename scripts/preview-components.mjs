import { build } from 'esbuild';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

// Run from the repository root: node scripts/preview-components.mjs
const bundle = await build({
  stdin: {
    contents: `import {TodoPanel} from './webview/todo-panel';
      import {extensionQuestion} from './webview/extension-question';
      window.components={TodoPanel,extensionQuestion};`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  write: false,
  format: 'iife',
});
const css = await readFile('webview/style.css', 'utf8');
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true,
  ignoreDefaultArgs: ['--hide-scrollbars'],
  args: ['--no-sandbox'],
});
try {
  const page = await browser.newPage({
    viewport: { width: 1260, height: 670 },
    deviceScaleFactor: 1.5,
  });
  await page.setContent(`<style>${css}
    body{margin:0;padding:24px;background:#11151b;color:#dedee4;display:block;font-family:system-ui,sans-serif;--border:#343d49;--input:#222a35;--muted:#9ca7b8;--vscode-input-background:#18202b;--vscode-input-foreground:#dedee4;--vscode-input-border:#435066}
    .previews{display:flex;gap:20px}.demo{width:390px;flex:none}.caption{font-size:15px;font-weight:600;margin-bottom:14px;color:#bfccdf}
    .window{height:550px;border:1px solid #3b4453;border-radius:10px;background:#191f28;overflow:hidden;display:flex;flex-direction:column}
    .window header{padding:14px;font-size:14px;border-bottom:1px solid var(--border)}
    .conversation{flex:1;min-height:0;padding:16px 18px;font-size:13px;line-height:1.8;overflow:hidden}
    .user-bubble{margin-left:35px;padding:10px;background:#293447;border-radius:9px;margin-bottom:18px}.reply{color:#c9d3e1}
    .fake-footer{border-top:1px solid var(--border);padding:12px;color:#8190a5;font-size:12px}.composer-demo{padding:10px;border:1px solid #3d4859;border-radius:8px;margin-top:8px;min-height:36px}
    .permission-card{font-size:12px;line-height:1.6}.permission-card textarea{font:12px/1.6 system-ui;padding:8px;border:1px solid var(--border);border-radius:4px;background:#18202b;color:#dedee4}
    .permission-actions{margin-top:8px}.permission-actions button{padding:5px 9px}.permission-actions button:first-child{background:#344e6e}
    .note{color:#8392a8;font-size:11px;margin-top:10px}.todo-list{scrollbar-color:#536278 #202733;scrollbar-width:thin}
    </style><div class="previews">${['Todo · 紧凑布局', 'Agent 提问 · 单选', 'Agent 提问 · 文本回答'].map((title, i) => `<div class="demo"><div class="caption">${title}</div><div class="window"><header>π Pi Agent <span style="float:right;color:#99a9bc">◷　＋</span></header>${i === 0 ? '<section id="plan"></section>' : ''}<div class="conversation"><div class="user-bubble">${i === 0 ? '请完成待办清单适配并验证。' : '请帮我完善 Todo 面板的展示效果。'}</div><div class="reply">${i === 0 ? '已接好待办状态同步，正在验证会话恢复。' : i === 1 ? '开始修改前，需要你选择一种显示方式。' : '请补充你希望的具体展示效果。'}<br><br><span style="color:#92a2b7">▸ ${i === 0 ? '处理中 · 3 次工具调用' : '等待你的回答'}</span></div></div>${i > 0 ? `<div id="question-${i}"></div>` : ''}<div class="fake-footer">${i === 0 ? 'Pi 正在处理…' : '回答后 Agent 将继续任务'}<div class="composer-demo">输入消息…</div></div></div><div class="note">${i === 0 ? '11px 字体 · 18px 行高 · 超过 5 项内部滚动' : i === 1 ? '点击选项提交，或取消本次提问。' : '输入后点击提交，内容将返回给 Agent。'}</div></div>`).join('')}</div>`);
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.evaluate(() => {
    const { TodoPanel, extensionQuestion } = window.components;
    const entries = [
      ['读取 rpiv-todo 状态快照', 'completed'],
      ['实现顶部悬浮卡片', 'completed'],
      ['验证会话恢复后的清单显示', 'in_progress'],
      ['加入折叠与内部滚动条', 'pending'],
      ['覆盖空列表及删除项测试', 'pending'],
      ['检查长标题显示', 'pending'],
      ['构建并部署更新', 'pending'],
    ].map(([content, status]) => ({ content, status, priority: 'medium' }));
    new TodoPanel(document.querySelector('#plan')).update(entries, 'preview');
    for (let i = 1; i <= 2; i++) {
      const input = i === 2;
      const card = extensionQuestion(
        {
          id: `demo-${i}`,
          request: {
            toolCall: {
              toolCallId: `pi-ui-demo-${i}`,
              title: input ? '还有哪些细节需要调整？' : '已完成的 Todo 应如何显示？',
              rawInput: {
                method: input ? 'input' : 'select',
                ...(input ? { placeholder: '例如：保留完成项，进行中的项目高亮…' } : {}),
              },
            },
            options: input
              ? [{ optionId: 'submit', name: '提交', kind: 'allow_once' }]
              : [
                  {
                    optionId: 'keep',
                    name: '保留已完成任务，在状态圆圈内打钩，方便回顾本轮工作进度',
                    kind: 'allow_once',
                  },
                  {
                    optionId: 'hide',
                    name: '自动隐藏已完成任务，只显示仍待处理和进行中的任务',
                    kind: 'allow_once',
                  },
                ],
            ...(input ? { _meta: { 'pi-workbench-input': true } } : {}),
          },
        },
        () => {},
      );
      document.querySelector(`#question-${i}`).append(card);
    }
  });
  const metrics = await page.locator('.todo-list').evaluate((list) => {
    const before = list.scrollTop;
    list.scrollTop = 18;
    const scrolled = list.scrollTop > before;
    list.scrollTop = 0;
    return { clientHeight: list.clientHeight, scrollHeight: list.scrollHeight, scrolled };
  });
  if (metrics.clientHeight !== 90 || metrics.scrollHeight <= 90 || !metrics.scrolled)
    throw new Error(`Todo scrolling failed: ${JSON.stringify(metrics)}`);
  console.log('Todo scrolling verified:', metrics);
  await mkdir('test-results/component-preview', { recursive: true });
  await page.screenshot({ path: 'test-results/component-preview/todo-and-questions.png' });
  const wrapping = await page.locator('#question-1 .extension-question').evaluate((card) => {
    card.style.width = '220px';
    const buttons = [...card.querySelectorAll('button')];
    const button = buttons[0];
    button.textContent =
      '这是一段需要完整显示的超长选项。'.repeat(12) + 'VeryLongUnbrokenOption'.repeat(20);
    const styles = getComputedStyle(button);
    return {
      wraps: styles.whiteSpace === 'normal' && styles.overflowWrap === 'anywhere',
      fullHeight: button.scrollHeight <= button.clientHeight + 1,
      fullWidth: button.scrollWidth <= button.clientWidth + 1,
      multiline: button.clientHeight > 60,
      vertical: buttons[1].getBoundingClientRect().top >= button.getBoundingClientRect().bottom,
    };
  });
  if (Object.values(wrapping).some((value) => !value))
    throw new Error(`Question wrapping failed: ${JSON.stringify(wrapping)}`);
  console.log('Long option wrapping verified:', wrapping);
} finally {
  await browser.close();
}
