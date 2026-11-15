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
        reset: '重新载入',
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
        reset: 'Reload',
      },
    };
    const empty = { provider: '', model: '', prompt: '' };
    function copyReview(value) {
      const review = value && value.review;
      return {
        provider: typeof review?.provider === 'string' ? review.provider : '',
        model: typeof review?.model === 'string' ? review.model : '',
        prompt: typeof review?.prompt === 'string' ? review.prompt : '',
      };
    }
    function ReviewPage({ view, form, t, loadCatalog }) {
      const state = form?.state;
      const [draft, setDraft] = React.useState(empty);
      const [revision, setRevision] = React.useState(undefined);
      const [dirty, setDirty] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState('');
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
      const conflict = dirty && state.revision !== revision;
      const selected = JSON.stringify([draft.provider, draft.model]);
      const known = catalog.groups.some(group => group.id === draft.provider && group.models.some(model => model.id === draft.model));
      const setField = patch => { setDraft(previous => ({ ...previous, ...patch })); setDirty(true); setMessage(''); };
      const invalid = !draft.prompt.trim() || Boolean(draft.provider.trim()) !== Boolean(draft.model.trim());
      const control = { boxSizing: 'border-box', width: '100%', padding: '8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', font: 'inherit' };
      const submit = async event => {
        event.preventDefault();
        if (!dirty || conflict || invalid || busy || !state.writable || revision === undefined) return;
        setBusy(true); setMessage('');
        try {
          const ok = await form.mutate([{ op: 'set', path: ['review'], value: draft }], revision);
          if (ok) { setDirty(false); setMessage(t('saved')); }
          else setMessage(t('rejected'));
        } catch (error) { setMessage(`${t('rejected')} ${String(error?.message || error)}`); }
        finally { setBusy(false); }
      };
      return h('form', { onSubmit: submit, style: { display: 'grid', gap: '12px', maxWidth: '760px' } },
        h('h3', { style: { margin: 0 } }, t('title')),
        h('p', { style: { margin: 0 } }, t('hint')),
        h('p', { style: { margin: 0, color: 'var(--dsw-alias-state-warn-primary)' } }, t('warning')),
        h('label', null, t('model'), h('select', {
          value: selected, disabled: busy || !state.writable,
          onChange: event => { const [provider, model] = JSON.parse(event.target.value); setField({ provider, model }); },
          style: { ...control, display: 'block', marginTop: '6px' },
        },
        h('option', { value: JSON.stringify(['', '']) }, t('inherit')),
        !known && (draft.provider || draft.model) ? h('option', { value: selected }, `${t('missing')}: ${draft.provider} / ${draft.model}`) : null,
        ...catalog.groups.map(group => h('optgroup', { key: group.id, label: group.name || group.id },
          ...group.models.map(model => h('option', { key: model.id, value: JSON.stringify([group.id, model.id]) }, model.name || model.id))))),
        ),
        catalog.loading ? h('div', { role: 'status' }, t('loadingModels')) : null,
        catalog.error ? h('div', { role: 'alert' }, `${t('modelError')}: ${catalog.error}`) : null,
        catalog.failures.length ? h('div', { role: 'alert' }, `${t('partial')}: ${catalog.failures.map(f => `${f.name || f.id}: ${f.message}`).join('; ')}`) : null,
        h('div', null, h('button', { type: 'button', disabled: catalog.loading, onClick: () => setReload(n => n + 1) }, t('retry'))),
        h('label', null, t('prompt'), h('textarea', { value: draft.prompt, rows: 16, disabled: busy || !state.writable, onChange: e => setField({ prompt: e.target.value }), style: { ...control, display: 'block', marginTop: '6px', resize: 'vertical', lineHeight: 1.5 } })),
        invalid ? h('div', { role: 'alert' }, t('invalid')) : null,
        !state.writable ? h('div', { role: 'alert' }, t('unavailable')) : null,
        conflict ? h('div', { role: 'alert' }, t('conflict')) : null,
        message ? h('div', { role: 'status' }, message) : null,
        h('div', { style: { display: 'flex', gap: '8px' } },
          h('button', { type: 'submit', disabled: !dirty || busy || conflict || invalid || !state.writable || revision === undefined }, busy ? t('saving') : t('save')),
          h('button', { type: 'button', disabled: !dirty || busy, onClick: () => { setDraft(copyReview(state.value)); setRevision(state.revision); setDirty(false); setMessage(''); } }, t('reset'))));
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
