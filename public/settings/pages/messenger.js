/**
 * Settings-Seite: Messenger (Telegram, Discord) und Tagesvorschau.
 *
 * Jedes Mitglied mit Freigabe richtet hier eigene Ziele ein und seine
 * Tagesvorschau; ein Admin zusaetzlich, wer das darf, die Ziele der Familie
 * und die Familien-Vorschau. Telegram und Discord sind Vorlagen des
 * Webhook-Kanals (#692): die Seite fragt nur nach Token und Chat-ID bzw. der
 * Webhook-Adresse, Adresse und Body baut der Server. Geheimnisse kommen nie
 * zurueck - ein gespeichertes Ziel zeigt nur, dass es eines hat.
 *
 * Server: /api/v1/notifications/personal (eigene), /api/v1/notifications
 * (Admin: access, channels, digest).
 */
import { t } from '/i18n.js';
import { api } from '/api.js';
import { confirmModal } from '/components/modal.js';
import { esc } from '/utils/html.js';
import { emptyStateHTML } from '/utils/empty-state.js';
import { errorSentence, errorSentenceWithDetail } from '/utils/friendly-error.js';
import { reloadAfterSave } from '/utils/reload-after-save.js';
import { toggleRowHtml } from '/settings/components.js';

const SERVICES = ['telegram', 'discord'];
const SERVICE_NAMES = { telegram: 'Telegram', discord: 'Discord' };

function toast(text, tone = 'success') {
  window.yuvomi?.showToast(text, tone);
}

function serviceOf(channel) {
  return SERVICES.includes(channel?.config?.preset) ? channel.config.preset : null;
}

function channelLabel(channel) {
  const service = serviceOf(channel);
  return service ? SERVICE_NAMES[service] : channel.provider;
}

/** Ein gespeichertes Ziel: Name, Dienst, an/aus, Test, Loeschen. */
function channelRowHtml(channel, scope) {
  return `
    <div class="settings-card messenger-channel" data-channel-id="${channel.id}" data-scope="${scope}">
      <h3 class="settings-card__title">${esc(channel.name)}</h3>
      <p class="form-hint">${esc(channelLabel(channel))}${channel.lastError ? ` · ${esc(channel.lastError)}` : ''}</p>
      ${toggleRowHtml({
        control: 'switch',
        label: t('settings.notificationChannelEnabled'),
        checked: Boolean(channel.enabled),
        attrs: { 'data-action': 'toggle' },
      })}
      <div class="settings-form-actions">
        <button type="button" class="btn btn--secondary" data-action="test">${t('settings.notificationChannelTest')}</button>
        <button type="button" class="btn btn--danger" data-action="delete">${t('settings.notificationChannelDelete')}</button>
      </div>
    </div>`;
}

/** Formular fuer ein neues Ziel; die Felder des gewaehlten Dienstes sind sichtbar. */
function addFormHtml(scope) {
  const id = (name) => `messenger-${scope}-${name}`;
  return `
    <form class="settings-card settings-form messenger-add" data-scope="${scope}" novalidate autocomplete="off">
      <div class="form-field">
        <label class="form-label" for="${id('service')}">${t('settings.messenger.service')}</label>
        <select class="form-input" id="${id('service')}" name="service">
          ${SERVICES.map((s) => `<option value="${s}">${SERVICE_NAMES[s]}</option>`).join('')}
        </select>
      </div>
      <div class="form-field">
        <label class="form-label" for="${id('name')}">${t('settings.notificationChannelName')}</label>
        <input class="form-input" id="${id('name')}" name="name" maxlength="80" required>
      </div>
      <div class="messenger-fields" data-service="telegram">
        <div class="form-field">
          <label class="form-label" for="${id('tg-token')}">${t('settings.messenger.telegramToken')}</label>
          <input class="form-input" id="${id('tg-token')}" name="telegramToken" type="password" autocomplete="new-password" spellcheck="false">
          <p class="form-hint">${t('settings.messenger.telegramTokenHint')}</p>
        </div>
        <div class="form-field">
          <label class="form-label" for="${id('tg-chat')}">${t('settings.messenger.telegramChat')}</label>
          <input class="form-input" id="${id('tg-chat')}" name="telegramChat" inputmode="text" spellcheck="false">
          <p class="form-hint">${t('settings.messenger.telegramChatHint')}</p>
        </div>
      </div>
      <div class="messenger-fields settings-card--hidden" data-service="discord">
        <div class="form-field">
          <label class="form-label" for="${id('dc-url')}">${t('settings.messenger.discordUrl')}</label>
          <input class="form-input" id="${id('dc-url')}" name="discordUrl" type="password" autocomplete="new-password" spellcheck="false">
          <p class="form-hint">${t('settings.messenger.discordUrlHint')}</p>
        </div>
      </div>
      <div class="form-error" role="alert" hidden></div>
      <div class="settings-form-actions">
        <button type="submit" class="btn btn--primary">${t('common.add')}</button>
      </div>
    </form>`;
}

/** Die Einstellungen einer Tagesvorschau (eigene oder Familie). */
function digestFormHtml(scope, digest, channels, sections) {
  const id = (name) => `messenger-digest-${scope}-${name}`;
  const chosen = new Set(digest.channelIds);
  return `
    <form class="settings-card settings-form messenger-digest" data-scope="${scope}" novalidate>
      ${toggleRowHtml({
        control: 'switch',
        label: t('settings.messenger.digestEnabled'),
        checked: Boolean(digest.enabled),
        attrs: { name: 'enabled' },
      })}
      <div class="form-field">
        <label class="form-label" for="${id('time')}">${t('settings.messenger.digestTime')}</label>
        <input class="form-input" id="${id('time')}" name="sendTime" type="time" value="${esc(digest.sendTime)}" required>
      </div>
      <div class="form-field">
        <label class="form-label" for="${id('day')}">${t('settings.messenger.digestDay')}</label>
        <select class="form-input" id="${id('day')}" name="day">
          <option value="tomorrow"${digest.day === 'tomorrow' ? ' selected' : ''}>${t('common.tomorrow')}</option>
          <option value="today"${digest.day === 'today' ? ' selected' : ''}>${t('common.today')}</option>
        </select>
      </div>
      <fieldset class="form-field">
        <legend class="form-label">${t('settings.messenger.digestSections')}</legend>
        ${sections.map((s) => toggleRowHtml({
          control: 'switch',
          label: t(`messenger.digest.section.${s}`),
          checked: digest.sections.includes(s),
          attrs: { name: 'section', value: s },
        })).join('')}
        <p class="form-hint">${t('settings.messenger.digestSectionsHint')}</p>
      </fieldset>
      ${channels.length ? `<fieldset class="form-field">
        <legend class="form-label">${t('settings.messenger.digestTargets')}</legend>
        ${channels.map((c) => toggleRowHtml({
          control: 'switch',
          label: c.name,
          checked: chosen.has(c.id),
          attrs: { name: 'channel', value: String(c.id) },
        })).join('')}
        <p class="form-hint">${t('settings.messenger.digestTargetsHint')}</p>
      </fieldset>` : ''}
      <div class="form-error" role="alert" hidden></div>
      <div class="settings-form-actions">
        ${channels.length ? `<button type="button" class="btn btn--secondary" data-action="digest-test">${t('settings.messenger.digestTest')}</button>` : ''}
        <button type="submit" class="btn btn--primary">${t('common.save')}</button>
      </div>
    </form>`;
}

function readDigestForm(form) {
  return {
    enabled: form.elements.enabled.checked,
    sendTime: form.elements.sendTime.value,
    day: form.elements.day.value,
    sections: [...form.querySelectorAll('input[name="section"]:checked')].map((el) => el.value),
    channelIds: [...form.querySelectorAll('input[name="channel"]:checked')].map((el) => Number(el.value)),
  };
}

function readAddForm(form) {
  const service = form.elements.service.value;
  const body = { provider: 'webhook', name: form.elements.name.value.trim(), enabled: true, config: { preset: service } };
  if (service === 'telegram') {
    body.config.chatId = form.elements.telegramChat.value.trim();
    body.secrets = { token: form.elements.telegramToken.value.trim() };
  } else {
    body.secrets = { token: form.elements.discordUrl.value.trim() };
  }
  return body;
}

// Was Telegram oder Discord ablehnt (Token, Chat-ID, Webhook) und was der
// Server an deren Daten beanstandet, kennt die App nicht als Fall - die Angabe
// steht deshalb im uebersetzten Rahmen (TECHNICAL_DETAIL_SITES, #1909).
function showError(form, err, frameKey = 'email.saveFailed') {
  const box = form.querySelector('.form-error');
  box.textContent = errorSentenceWithDetail(err, frameKey, 'settings.notificationChannelError');
  box.hidden = false;
}

async function loadState(user) {
  const personal = (await api.get('/notifications/personal')).data;
  const state = { personal, admin: null };
  if (user?.role === 'admin') {
    const [access, channels, digest] = await Promise.all([
      api.get('/notifications/access'), api.get('/notifications/channels'), api.get('/notifications/digest'),
    ]);
    state.admin = { access: access.data, channels: channels.data, digest: digest.data };
  }
  return state;
}

function renderPage(container, state) {
  const { personal, admin } = state;
  const mine = personal.channels;
  container.replaceChildren();
  container.insertAdjacentHTML('beforeend', `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.messenger.mineTitle')}</h2>
      ${personal.allowed ? `
        <p class="form-hint">${t('settings.messenger.mineHint')}</p>
        <div class="messenger-list" data-scope="user">
          ${mine.length ? mine.map((c) => channelRowHtml(c, 'user')).join('') : emptyStateHTML({ compact: true, description: t('settings.messenger.empty') })}
        </div>
        ${mine.length < personal.maxChannels ? addFormHtml('user') : ''}
      ` : `<p class="form-hint">${t('settings.messenger.notAllowed')}</p>
        ${mine.length ? `<div class="messenger-list" data-scope="user">${mine.map((c) => channelRowHtml(c, 'user')).join('')}</div>` : ''}`}
    </section>
    ${personal.allowed ? `<section class="settings-section">
      <h2 class="settings-section__title">${t('settings.messenger.digestTitle')}</h2>
      ${digestFormHtml('user', personal.digest, mine, personal.sections)}
    </section>` : ''}
    ${admin ? `
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.messenger.accessTitle')}</h2>
      <p class="form-hint">${t('settings.messenger.accessHint')}</p>
      <div class="row-carrier settings-group messenger-access">
        ${admin.access.map((m) => toggleRowHtml({
          control: 'switch',
          label: m.display_name,
          checked: m.allowed,
          disabled: m.admin,
          attrs: { 'data-member': String(m.user_id) },
        })).join('')}
      </div>
    </section>
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.messenger.householdTitle')}</h2>
      <p class="form-hint">${t('settings.messenger.householdHint')}</p>
      <div class="messenger-list" data-scope="household">
        ${admin.channels.filter(serviceOf).map((c) => channelRowHtml(c, 'household')).join('')
          || emptyStateHTML({ compact: true, description: t('settings.messenger.empty') })}
      </div>
      ${addFormHtml('household')}
    </section>
    <section class="settings-section">
      <h2 class="settings-section__title">${t('settings.messenger.householdDigestTitle')}</h2>
      <p class="form-hint">${t('settings.messenger.householdDigestHint')}</p>
      ${digestFormHtml('household', admin.digest, admin.channels.filter((c) => c.scope !== 'user'), admin.digest.sectionsAvailable)}
    </section>` : ''}
  `);
  window.lucide?.createIcons({ el: container });
}

const base = (scope) => (scope === 'household' ? '/notifications' : '/notifications/personal');

function bindEvents(container, user) {
  const refresh = async () => {
    renderPage(container, await loadState(user));
  };

  container.addEventListener('change', async (event) => {
    const el = event.target;
    if (el.name === 'service' && el.form?.classList.contains('messenger-add')) {
      for (const block of el.form.querySelectorAll('.messenger-fields')) {
        block.classList.toggle('settings-card--hidden', block.dataset.service !== el.value);
      }
      return;
    }
    if (el.dataset.member) {
      el.disabled = true;
      try {
        await api.put(`/notifications/access/${el.dataset.member}`, { allowed: el.checked });
        toast(t('settings.messenger.digestSaved'));
      } catch {
        el.checked = !el.checked;
        toast(t('settings.notificationChannelError'), 'danger');
      } finally {
        el.disabled = false;
      }
      return;
    }
    const row = el.closest('.messenger-channel');
    if (row && el.dataset.action === 'toggle') {
      try {
        await api.put(`${base(row.dataset.scope)}/channels/${row.dataset.channelId}`, { enabled: el.checked });
      } catch (err) {
        el.checked = !el.checked;
        toast(errorSentence(err, 'settings.notificationChannelError'), 'danger');
      }
    }
  });

  container.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const row = button.closest('.messenger-channel');
    if (row && button.dataset.action === 'test') {
      button.disabled = true;
      try {
        await api.post(`${base(row.dataset.scope)}/channels/${row.dataset.channelId}/test`, {});
        toast(t('settings.notificationChannelTestSent'));
      } catch (err) {
        toast(errorSentenceWithDetail(err, 'settings.messenger.testFailed', 'settings.notificationChannelError'), 'danger');
      } finally {
        button.disabled = false;
      }
    } else if (row && button.dataset.action === 'delete') {
      const confirmed = await confirmModal(t('settings.notificationChannelDeleteConfirm'), {
        confirmLabel: t('settings.notificationChannelDelete'),
        danger: true,
        detail: t('settings.notificationChannelDeleteConfirmDetail'),
      });
      if (!confirmed) return;
      try {
        await api.delete(`${base(row.dataset.scope)}/channels/${row.dataset.channelId}`);
      } catch (err) {
        toast(errorSentence(err, 'settings.notificationChannelError'), 'danger');
        return;
      }
      toast(t('settings.notificationChannelDeleted'));
      await reloadAfterSave(refresh);
    } else if (button.dataset.action === 'digest-test') {
      const form = button.closest('form');
      const values = readDigestForm(form);
      const channelId = values.channelIds[0] ?? Number(form.querySelector('input[name="channel"]')?.value);
      button.disabled = true;
      try {
        // Erst speichern: getestet wird, was eingestellt ist, nicht der alte Stand.
        await api.put(`${base(form.dataset.scope)}/digest`, values);
        await api.post(`${base(form.dataset.scope)}/digest/test`, { channelId });
        toast(t('settings.notificationChannelTestSent'));
      } catch (err) {
        showError(form, err, 'settings.messenger.testFailed');
      } finally {
        button.disabled = false;
      }
    }
  });

  container.addEventListener('submit', async (event) => {
    const form = event.target;
    event.preventDefault();
    form.querySelector('.form-error').hidden = true;
    const adding = form.classList.contains('messenger-add');
    try {
      if (adding) await api.post(`${base(form.dataset.scope)}/channels`, readAddForm(form));
      else if (form.classList.contains('messenger-digest')) await api.put(`${base(form.dataset.scope)}/digest`, readDigestForm(form));
      else return;
    } catch (err) {
      showError(form, err);
      return;
    }
    toast(t(adding ? 'settings.notificationChannelSaved' : 'settings.messenger.digestSaved'));
    if (adding) await reloadAfterSave(refresh);
  });
}

export async function render(container, { user } = {}) {
  renderPage(container, await loadState(user));
  bindEvents(container, user);
}

export const __test = { readAddForm, readDigestForm, serviceOf };
