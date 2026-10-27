import type { ClientCommand, Interaction, SessionView } from '../src/workbench-protocol';
import { element, button } from './workbench-elements';

type AnswerCommand = Extract<ClientCommand, { method: 'answer' }>;

/** Keep DOM ownership here: streaming updates must not erase a half-filled form. */
export function renderInteractions(
  interactions: HTMLElement,
  snapshot: SessionView,
  answer: (command: AnswerCommand) => void,
) {
  const existing = new Map(
    [...interactions.children].map((child) => [child.getAttribute('data-interaction'), child]),
  );
  const retained = new Set<string>();
  for (const interaction of Object.values(snapshot.pending_interactions)) {
    const signature = JSON.stringify(interaction),
      old = existing.get(interaction.id);
    retained.add(interaction.id);
    if (old?.getAttribute('data-definition') === signature) continue;
    old?.remove();
    const box = element('form');
    box.className = 'permission-card';
    box.dataset.interaction = interaction.id;
    box.dataset.definition = signature;
    if (interaction.question) {
      renderQuestion(box, interaction, snapshot, answer);
      interactions.append(box);
      continue;
    }
    box.append(
      element(
        'strong',
        interaction.kind === 'Permission' && !interaction.title.startsWith('需要授权')
          ? `需要授权 · ${interaction.title}`
          : interaction.title,
      ),
      element(interaction.kind === 'Permission' ? 'pre' : 'p', interaction.detail),
    );
    const interactionActions = element('div');
    interactionActions.className = 'permission-actions';
    if (interaction.kind === 'Permission') {
      for (const option of interaction.options)
        interactionActions.append(
          button(
            option.label,
            () =>
              answer({
                method: 'answer',
                session: snapshot.id,
                answer: {
                  interaction: interaction.id,
                  response: { Permission: { option: option.id } },
                },
              }),
            false,
            false,
          ),
        );
    } else {
      type FieldValue = Extract<
        import('../src/workbench-protocol').InteractionAnswer['response'],
        { Form: unknown }
      >['Form']['fields'][string];
      const inputs: { name: string; get(): FieldValue | undefined }[] = [];
      for (const field of interaction.fields) {
        const label = element('label', field.label),
          kind = field.kind;
        if (kind === 'Boolean') {
          const input = element('input');
          input.type = 'checkbox';
          label.append(input);
          inputs.push({ name: field.name, get: () => ({ Boolean: input.checked }) });
        } else if ('Text' in kind) {
          const input = element('textarea');
          input.required = field.required;
          input.maxLength = kind.Text.max_length;
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => (input.value || field.required ? { Text: input.value } : undefined),
          });
        } else if ('Choice' in kind) {
          const input = element('select');
          input.multiple = kind.Choice.multiple;
          input.required = field.required;
          if (!field.required && !input.multiple) {
            const empty = element('option', 'No selection');
            empty.value = '';
            input.append(empty);
          }
          for (const option of kind.Choice.options) {
            const node = element('option', option.label);
            node.value = option.id;
            input.append(node);
          }
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => ({
              Selected: [...input.selectedOptions].map((option) => option.value).filter(Boolean),
            }),
          });
        } else {
          const input = element('input');
          input.type = 'number';
          input.step = '1';
          input.required = field.required;
          if (kind.Integer.min !== null) input.min = String(kind.Integer.min);
          if (kind.Integer.max !== null) input.max = String(kind.Integer.max);
          label.append(input);
          inputs.push({
            name: field.name,
            get: () => (input.value ? { Integer: Number(input.value) } : undefined),
          });
        }
        box.append(label);
      }
      const submit = element('button', '提交回答');
      submit.type = 'submit';
      box.append(submit);
      box.addEventListener('submit', (event) => {
        event.preventDefault();
        if (!box.reportValidity()) return;
        const fields: Record<string, FieldValue> = Object.create(null);
        for (const input of inputs) {
          const value = input.get();
          if (value !== undefined) fields[input.name] = value;
        }
        answer({
          method: 'answer',
          session: snapshot.id,
          answer: { interaction: interaction.id, response: { Form: { fields } } },
        });
      });
    }
    interactionActions.append(
      button('Decline', () =>
        answer({
          method: 'answer',
          session: snapshot.id,
          answer: { interaction: interaction.id, response: 'Decline' },
        }),
      ),
    );
    box.append(interactionActions);
    interactions.append(box);
  }
  for (const [id, child] of existing) if (!id || !retained.has(id)) child.remove();
}

/** Pi extension questions retain the v1 card; their wire answers remain typed. */
function renderQuestion(
  box: HTMLFormElement,
  interaction: Interaction,
  snapshot: SessionView,
  answer: (command: AnswerCommand) => void,
) {
  const question = interaction.question!;
  box.classList.add('extension-question');
  const title = element('div', question.title || '请选择');
  title.className = 'question-title';
  box.append(element('strong', 'Pi · 等待你的回答'), title);
  if (question.message) box.append(element('p', question.message));
  let editor: HTMLTextAreaElement | undefined;
  if (question.method === 'input' || question.method === 'editor') {
    editor = element('textarea');
    editor.rows = question.method === 'editor' ? 6 : 3;
    editor.maxLength = 10000;
    editor.setAttribute('aria-label', '回答');
    editor.placeholder = question.placeholder || '输入你的回答';
    editor.value = question.prefill;
    box.append(editor);
  }
  const actions = element('div');
  actions.className = 'permission-actions';
  const respond = (response: AnswerCommand['answer']['response']) => {
    answer({
      method: 'answer',
      session: snapshot.id,
      answer: { interaction: interaction.id, response },
    });
    for (const control of box.querySelectorAll('button')) control.disabled = true;
  };
  if (editor) {
    const submit = element('button', '提交回答');
    submit.type = 'submit';
    actions.append(submit);
    box.addEventListener('submit', (event) => {
      event.preventDefault();
      respond({ Form: { fields: { value: { Text: editor!.value } } } });
    });
  } else {
    for (const option of interaction.options)
      actions.append(
        button(option.label, () => respond({ Permission: { option: option.id } }), false, false),
      );
    box.addEventListener('submit', (event) => event.preventDefault());
  }
  actions.append(button('取消', () => respond('Cancel'), false, false));
  box.append(actions);
}
