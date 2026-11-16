window.__ModuleLoader__.load({
  id: '@local/dsh-configurable-auto-review',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'configurable-auto-review';
    const dictionaries = {
      zh: {
        summary: '配置审查模型与完整审查提示词', title: '审查设置', model: '审查模型',
        inherit: '沿用会话模型', missing: '当前模型不可用', prompt: '审查 Prompt',
        hint: '选择已配置的模型，或沿用会话；审查 Prompt 支持完整多行编辑。',
        warning: '审查信息将发送给所选模型服务商。修改 Prompt 会改变权限判断；允许的操作具有完全访问权限。禁用或重载插件可能将 Auto 会话切换为完全访问，请先切换权限模式。', invalid: 'Prompt 不能为空，模型和服务商必须同时选择。',
        loading: '正在加载配置…', unavailable: '配置不可用或不可写。',
        loadingModels: '正在加载模型…', modelError: '模型列表加载失败', partial: '部分提供商模型加载失败',
        retry: '重新加载模型', save: '保存', saving: '保存中…', saved: '已保存。',
        rejected: '保存失败或配置已变化，请重新加载后再试。', conflict: '配置已在其他位置更改，请放弃本地编辑并重新载入。',
        reset: '重新载入', effort: '思考强度', effortDefault: '模型默认',
        effortHint: '可选强度由模型提供；选择模型默认时不沿用会话的思考强度。',
        effortInherit: '沿用会话模型时显示已配置模型的强度选项；请确认每个会话模型都支持所选强度，否则审查会失败并拒绝调用。',
        effortUnavailable: '当前模型未提供此强度；保存前请改为可用选项或模型默认。',
        effortUnknown: '当前强度不可用', effortUnverified: '无法核实当前模型支持的强度；请重新加载模型。若保存了不受支持的强度，审查将失败并拒绝调用。', promptHint: '完整提示词将用于每次权限审查，请谨慎修改。',
        safety: '安全提示', approvalTool: '待审核工具', approvalCommand: '待执行命令（JSON 字符串）', approvalArgs: '调用参数（JSON，来自会话记录）',
        approvalMissing: '无法确认待审核调用的完整参数，请勿盲目批准。', approvalPrivacy: '参数可能包含敏感信息；长内容请滚动查看。',
      },
      en: {
        summary: 'Configure the review model and full review prompt', title: 'Review settings', model: 'Review model',
        inherit: 'Use the session model', missing: 'Current model unavailable', prompt: 'Review prompt',
        hint: 'Choose an available model or use the session model; the complete multiline prompt is editable.',
        warning: 'Review data is sent to the selected provider. Editing the prompt changes authorization decisions; allowed actions have full access. Disabling or reloading this plugin may switch Auto sessions to full access; change their permission mode first.', invalid: 'The prompt must not be empty; provider and model must be selected together.',
        loading: 'Loading configuration…', unavailable: 'Configuration is unavailable or read-only.',
        loadingModels: 'Loading models…', modelError: 'Failed to load models', partial: 'Some providers failed to load',
        retry: 'Reload models', save: 'Save', saving: 'Saving…', saved: 'Saved.',
        rejected: 'Save failed or configuration changed. Reload and try again.', conflict: 'Configuration changed elsewhere. Discard local edits and reload.',
        reset: 'Reload', effort: 'Reasoning effort', effortDefault: 'Model default',
        effortHint: 'Available levels are provided by the model. Model default does not inherit the session effort.',
        effortInherit: 'When using the session model, levels from configured models are shown. Make sure every session model supports the selected level; otherwise review fails and the call is denied.',
        effortUnavailable: 'This level is not available for the selected model. Choose an available level or model default before saving.',
        effortUnknown: 'Current level unavailable', effortUnverified: 'The supported levels for this model could not be verified; reload models. If an unsupported level is saved, review fails and the call is denied.', promptHint: 'The complete prompt is used for every permission review; edit with care.',
        safety: 'Safety notice', approvalTool: 'Pending tool', approvalCommand: 'Pending command (JSON string)', approvalArgs: 'Call arguments (JSON, from the session record)',
        approvalMissing: 'The complete arguments for this approval could not be verified. Do not approve blindly.', approvalPrivacy: 'Arguments may contain sensitive information; scroll to view long content.',
      },
    };
    // Match the actual approval call, including nested PTC calls. Never fall
    // back to a parent or a same-named call when identity is missing/ambiguous.
    function approvalCall(snapshot, callId) {
      let found;
      let ambiguous = false;
      const seen = new Set();
      const visit = block => {
        if (!block || seen.has(block)) return;
        seen.add(block);
        if (block.callId === callId && !('kind' in block) && block.phase === 'start') {
          if (found) ambiguous = true;
          else found = block;
        }
        if (Array.isArray(block.subCalls)) for (const child of block.subCalls) visit(child);
      };
      for (const node of snapshot.nodes.values()) if (node.kind === 'tool-call') visit(node.data.root);
      return ambiguous ? undefined : found;
    }
    // Make direction and invisible controls visible without normalizing the
    // logged JSON (which could otherwise hide duplicate keys or large numbers).
    function approvalRaw(text) {
      return text.replace(/[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g,
        char => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
    }
    function approvalJson(value) {
      return approvalRaw(JSON.stringify(value, null, 2));
    }
    function ApprovalDetail({ callId, useChat, t }) {
      const call = useChat(snapshot => approvalCall(snapshot, callId));
      let args;
      try {
        if (!call || typeof call.name !== 'string' || !call.name || typeof call.argsRaw !== 'string') throw new Error('missing call');
        args = JSON.parse(call.argsRaw);
      } catch {
        return h('div', { role: 'status' }, t('approvalMissing'));
      }
      const command = args && typeof args === 'object' && !Array.isArray(args)
        ? (call.name === 'terminal_send' ? args.text : args.command) : undefined;
      const textStyle = { margin: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', wordBreak: 'break-all', unicodeBidi: 'plaintext', direction: 'ltr' };
      return h('div', { style: { minWidth: 0 } },
        h('div', null, t('approvalPrivacy')),
        h('div', null, `${t('approvalTool')}: `, h('code', { style: textStyle }, approvalJson(call.name))),
        typeof command === 'string' ? h('div', null,
          h('div', null, t('approvalCommand')), h('pre', { style: textStyle }, approvalJson(command))) : null,
        h('div', null, t('approvalArgs')), h('pre', { style: textStyle }, approvalRaw(call.argsRaw)));
    }
    const empty = { provider: '', model: '', prompt: '', reasoningEffort: '' };
    function copyReview(value) {
      const review = value && value.review;
      return {
        provider: typeof review?.provider === 'string' ? review.provider : '',
        model: typeof review?.model === 'string' ? review.model : '',
        prompt: typeof review?.prompt === 'string' ? review.prompt : '',
        reasoningEffort: typeof review?.reasoningEffort === 'string' ? review.reasoningEffort : '',
      };
    }
    function ReviewPage({ view, form, t, loadCatalog }) {
      const state = form?.state;
      const [draft, setDraft] = React.useState(empty);
      const [revision, setRevision] = React.useState(undefined);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
      const [messageError, setMessageError] = React.useState(false);
      const [catalog, setCatalog] = React.useState({ groups: [], failures: [], loading: false, error: '' });
      const [reload, setReload] = React.useState(0);
      React.useEffect(() => {
        if (!dirty && state?.status === 'ready') {
          setDraft(copyReview(state.value));
          setRevision(state.revision);
        }
      }, [dirty, state?.status, state?.value, state?.revision]);
      React.useEffect(() => {
        if (view !== 'page') return;
        let active = true;
        setCatalog(previous => ({ ...previous, loading: true, error: '' }));
        Promise.resolve().then(loadCatalog).then(result => {
          if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
          if (active) setCatalog({ groups: result.value.groups, failures: result.value.failures, loading: false, error: '' });
        }).catch(error => {
          if (active) setCatalog(previous => ({ ...previous, loading: false, error: String(error?.message || error) }));
        });
        return () => { active = false; };
      }, [view, loadCatalog, reload]);
      if (view === 'summary') return t('summary');
      if (!state || state.status === 'loading') return h('p', null, t('loading'));
      if (state.status !== 'ready') return h('p', { role: 'alert' }, t('unavailable'));
      if (!dirty && revision === undefined) return h('p', { role: 'status' }, t('loading'));
      const conflict = dirty && state.revision !== revision;
      const selected = JSON.stringify([draft.provider, draft.model]);
      const selectedModel = catalog.groups.find(group => group.id === draft.provider)?.models.find(model => model.id === draft.model);
      const known = Boolean(selectedModel);
      const candidates = draft.provider
        ? (selectedModel?.reasoning?.efforts || [])
        : catalog.groups.flatMap(group => group.models.flatMap(model => model.reasoning?.efforts || []));
      const efforts = [...new Map(candidates.map(effort => [effort.id, effort])).values()];
      const effortKnown = efforts.some(effort => effort.id === draft.reasoningEffort);
      const effortInvalid = Boolean(draft.reasoningEffort && selectedModel && !effortKnown);
      const setField = patch => { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); setMessage(''); setMessageError(false); };
      const invalid = !draft.prompt.trim() || Boolean(draft.provider.trim()) !== Boolean(draft.model.trim());
      const submit = async event => {
        event.preventDefault();
        if (!dirty || conflict || invalid || effortInvalid || busy || !state.writable || revision === undefined) return;
        setBusy(true); setMessage('');
        try {
          const ok = await form.mutate([{ op: 'set', path: ['review'], value: draft }], revision);
          if (ok) { setDirty(false); setMessageError(false); setMessage(t('saved')); }
          else { setMessageError(true); setMessage(t('rejected')); }
        } catch (error) { setMessageError(true); setMessage(`${t('rejected')} ${String(error?.message || error)}`); }
        finally { setBusy(false); }
      };
      return h('form', { onSubmit: submit, className: 'dsh-review-card' },
        h('style', null, `
          .dsh-review-card { box-sizing: border-box; display: grid; gap: 20px; width: 100%; max-width: 960px; padding: clamp(16px, 3vw, 22px); border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-layer-1); background: color-mix(in srgb, var(--dsw-alias-bg-layer-1) 90%, transparent); color: var(--dsw-alias-label-primary); box-shadow: 0 12px 36px color-mix(in srgb, var(--dsw-alias-bg-base) 65%, transparent), inset 0 1px 0 var(--dsw-alias-border-l1); }
          .dsh-review-card * { box-sizing: border-box; }
          .dsh-review-heading { display: grid; gap: 5px; }
          .dsh-review-heading h3, .dsh-review-card p { margin: 0; }
          .dsh-review-heading h3 { font-size: 15px; font-weight: 650; }
          .dsh-review-hint { color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
          .dsh-review-warning { padding: 10px 12px; border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 8%, transparent); color: var(--dsw-alias-state-warn-primary); font-size: 12px; line-height: 1.6; }
          .dsh-review-warning strong { display: block; margin-bottom: 2px; font-size: 12px; }
          .dsh-review-section { display: grid; gap: 8px; min-width: 0; }
          .dsh-review-label { display: block; font-size: 13px; font-weight: 600; }
          .dsh-review-control { display: block; width: 100%; min-width: 0; padding: 9px 11px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 13px; }
          .dsh-review-control:focus-visible, .dsh-review-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
          textarea.dsh-review-control { min-height: 220px; resize: vertical; line-height: 1.55; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
          .dsh-review-button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; cursor: pointer; }
          .dsh-review-button:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
          .dsh-review-button:disabled { opacity: .5; cursor: not-allowed; }
          .dsh-review-primary { border-color: var(--dsw-alias-brand-primary); background: color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, var(--dsw-alias-bg-layer-1)); }
          .dsh-review-actions { display: flex; flex-wrap: wrap; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border-l1); }
          .dsh-review-status { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); overflow-wrap: anywhere; }
          .dsh-review-error { color: var(--dsw-alias-state-error-primary); }
        `),
        h('header', { className: 'dsh-review-heading' }, h('h3', null, t('title')), h('p', { className: 'dsh-review-hint' }, t('hint'))),
        h('div', { className: 'dsh-review-warning' }, h('strong', null, t('safety')), t('warning')),
        h('div', { className: 'dsh-review-section' },
          h('label', { className: 'dsh-review-label', htmlFor: 'dsh-review-model' }, t('model')),
          h('select', { id: 'dsh-review-model', className: 'dsh-review-control', value: selected, disabled: busy || !state.writable,
            onChange: event => { const [provider, model] = JSON.parse(event.target.value); setField({ provider, model }); },
          },
          h('option', { value: JSON.stringify(['', '']) }, t('inherit')),
          !known && (draft.provider || draft.model) ? h('option', { value: selected }, `${t('missing')}: ${draft.provider} / ${draft.model}`) : null,
          ...catalog.groups.map(group => h('optgroup', { key: group.id, label: group.name || group.id },
            ...group.models.map(model => h('option', { key: model.id, value: JSON.stringify([group.id, model.id]) }, model.name || model.id))))),
          catalog.loading ? h('div', { className: 'dsh-review-status', role: 'status' }, t('loadingModels')) : null,
          catalog.error ? h('div', { className: 'dsh-review-status dsh-review-error', role: 'alert' }, `${t('modelError')}: ${catalog.error}`) : null,
          catalog.failures.length ? h('div', { className: 'dsh-review-status dsh-review-error', role: 'alert' }, `${t('partial')}: ${catalog.failures.map(f => `${f.name || f.id}: ${f.message}`).join('; ')}`) : null,
          h('div', null, h('button', { className: 'dsh-review-button', type: 'button', disabled: catalog.loading, onClick: () => setReload(n => n + 1) }, t('retry')))),
        h('div', { className: 'dsh-review-section' },
          h('label', { className: 'dsh-review-label', htmlFor: 'dsh-review-effort' }, t('effort')),
          h('select', { id: 'dsh-review-effort', className: 'dsh-review-control', value: draft.reasoningEffort, disabled: busy || !state.writable,
            'aria-describedby': effortInvalid ? 'dsh-review-effort-hint dsh-review-effort-error' : 'dsh-review-effort-hint', 'aria-invalid': effortInvalid || undefined,
            onChange: event => setField({ reasoningEffort: event.target.value }),
          }, h('option', { value: '' }, t('effortDefault')),
          draft.reasoningEffort && !effortKnown ? h('option', { value: draft.reasoningEffort }, `${t('effortUnknown')}: ${draft.reasoningEffort}`) : null,
          ...efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))),
          h('p', { id: 'dsh-review-effort-hint', className: 'dsh-review-hint' }, t('effortHint')),
          !draft.provider ? h('p', { className: 'dsh-review-hint' }, t('effortInherit')) : null,
          efforts.find(effort => effort.id === draft.reasoningEffort)?.description ? h('p', { className: 'dsh-review-hint' }, efforts.find(effort => effort.id === draft.reasoningEffort).description) : null,
          effortInvalid ? h('div', { id: 'dsh-review-effort-error', className: 'dsh-review-status dsh-review-error', role: 'alert' }, t('effortUnavailable')) : null,
          draft.provider && draft.reasoningEffort && !known && !catalog.loading ? h('div', { className: 'dsh-review-status dsh-review-error', role: 'alert' }, t('effortUnverified')) : null),
        h('div', { className: 'dsh-review-section' },
          h('label', { className: 'dsh-review-label', htmlFor: 'dsh-review-prompt' }, t('prompt')),
          h('p', { className: 'dsh-review-hint', id: 'dsh-review-prompt-hint' }, t('promptHint')),
          h('textarea', { id: 'dsh-review-prompt', className: 'dsh-review-control', required: true, 'aria-invalid': !draft.prompt.trim() || undefined, 'aria-describedby': invalid ? 'dsh-review-prompt-hint dsh-review-invalid' : 'dsh-review-prompt-hint', value: draft.prompt, rows: 16, disabled: busy || !state.writable, onChange: e => setField({ prompt: e.target.value }) })),
        invalid ? h('div', { id: 'dsh-review-invalid', className: 'dsh-review-status dsh-review-error', role: 'alert' }, t('invalid')) : null,
        !state.writable ? h('div', { className: 'dsh-review-status dsh-review-error', role: 'alert' }, t('unavailable')) : null,
        conflict ? h('div', { className: 'dsh-review-status dsh-review-error', role: 'alert' }, t('conflict')) : null,
        message ? h('div', { className: messageError ? 'dsh-review-status dsh-review-error' : 'dsh-review-status', role: messageError ? 'alert' : 'status' }, message) : null,
        h('div', { className: 'dsh-review-actions' },
          h('button', { className: 'dsh-review-button dsh-review-primary', type: 'submit', disabled: !dirty || busy || conflict || invalid || effortInvalid || !state.writable || revision === undefined }, busy ? t('saving') : t('save')),
          h('button', { className: 'dsh-review-button', type: 'button', disabled: !dirty || busy, onClick: () => { setDraft(copyReview(state.value)); setRevision(state.revision); setDirty(false); setMessage(''); } }, t('reset'))));
    }
    return {
      inject: ['slots', 'locale', 'remote', 'remote.session'],
      apply(ctx) {
        // DSH 0.2.2 has single-owner dictionaries: a private Chinese variant
        // overrides only the two Auto-review texts and falls back to zh elsewhere.
        const warningLocale = 'zh-x-dshrev';
        ctx.effect(() => ctx.locale.addLanguage({ id: warningLocale, label: '中文（可配置自动审查）', fallback: 'zh' }), 'configurable-auto-review: warning language');
        ctx.effect(() => ctx.locale.register('permission.access', warningLocale, {
          'auto.description': '无沙箱运行；原生工具和 PTC 内层调用前使用可配置的模型进行实验性审查。',
          'auto.confirm.description': '自动审查不使用沙箱。每次原生工具和 PTC 内层调用前，使用插件配置的审查模型；未指定时沿用当前 Agent 模型。审查提示词可在插件设置中查看和修改。被拒绝的调用可能需你批准，或被直接拒绝；PTC 中直接执行的 Node 操作不受审查。此功能仍属实验性，可能误放行或误拒绝，并会消耗额外 token。',
        }), 'configurable-auto-review: permission warning');
        ctx.effect(() => ctx.locale.register(NS, dictionaries), 'configurable-auto-review: locale');
        const t = ctx.locale.bind(NS);
        const loadCatalog = () => ctx.remote.session.modelCatalog();
        // Single slots select the lowest priority; the built-in uses 0. This
        // shared replacement also covers non-Auto approvals.
        ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register({
          name: 'conversation.approval.detail', priority: -100, locale: NS,
          inject: () => ({ t }),
        }, ApprovalDetail));
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: '@local/dsh-configurable-auto-review#configurable-auto-review',
          locale: NS,
          inject: () => ({ t, loadCatalog }),
        }, ReviewPage));
      },
    };
  },
});
