const api = window.dshDesktop

const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const TRANSACTION_ACTIVE_PATTERN = /another package transaction is active/u
const MAX_ERROR_CHARS = 500

function shortError(error) {
  const raw = error instanceof Error ? error.message : String(error)
  const first = raw.split('\n', 1)[0] ?? raw
  const trimmed = first.trim()
  return trimmed.length <= MAX_ERROR_CHARS ? trimmed : `${trimmed.slice(0, MAX_ERROR_CHARS - 3)}...`
}

async function main() {
  const locale = await api.locale()
  const packaged = locale.packaged !== false
  const messages = locale.messages
  const message = (key, values = {}) => {
    const template = messages[key] ?? key
    return template.replaceAll(/\{([^{}]+)\}/gu, (placeholder, name) => values[name] ?? placeholder)
  }
  const displayError = (error) => (
    TRANSACTION_ACTIVE_PATTERN.test(error instanceof Error ? error.message : String(error))
      ? messages.transactionActive
      : shortError(error)
  )
  document.documentElement.lang = locale.id
  document.querySelector('#page-title').textContent = messages.pluginManagerTitle
  document.querySelector('#title').textContent = messages.pluginManagerTitle
  document.querySelector('#description').textContent = messages.pluginManagerDescription
  document.querySelector('#refresh').textContent = messages.refresh
  document.querySelector('#package-label').textContent = messages.npmPackage
  document.querySelector('#install').textContent = messages.install
  document.querySelector('#installed-heading').textContent = messages.installed
  document.querySelector('#empty').textContent = messages.noPlugins
  document.querySelector('#updates-heading').textContent = messages.updatesHeading
  document.querySelector('#updates-description').textContent = messages.updatesDescription
  document.querySelector('#check-updates').textContent = messages.checkForUpdates
  document.querySelector('#install-update').textContent = messages.installUpdate

  const list = document.querySelector('#plugins')
  const empty = document.querySelector('#empty')
  const status = document.querySelector('#status')
  const form = document.querySelector('#install-form')
  const input = document.querySelector('#package-spec')
  const refresh = document.querySelector('#refresh')
  const devNotice = document.querySelector('#dev-notice')
  const currentVersion = document.querySelector('#current-version')
  const checkUpdates = document.querySelector('#check-updates')
  const installUpdate = document.querySelector('#install-update')
  const updateStatus = document.querySelector('#update-status')

  if (!packaged) {
    devNotice.hidden = false
    devNotice.textContent = messages.packagedOnlyNotice
    for (const control of form.querySelectorAll('button, input')) control.disabled = true
    checkUpdates.disabled = true
    installUpdate.disabled = true
  }

  function setBusy(busy, statusMessage = '') {
    for (const control of document.querySelectorAll('button, input')) {
      if (!packaged) continue
      control.disabled = busy
    }
    status.textContent = statusMessage
  }

  function renderUpdateEditor(item, plugin, onDone) {
    const editor = document.createElement('div')
    editor.className = 'update-editor'
    const label = document.createElement('label')
    label.textContent = message('updateToVersion', { name: plugin.name })
    const row = document.createElement('div')
    row.className = 'install-row'
    const versionInput = document.createElement('input')
    versionInput.value = plugin.version
    versionInput.setAttribute('aria-label', message('updateToVersion', { name: plugin.name }))
    const apply = document.createElement('button')
    apply.type = 'button'
    apply.textContent = messages.applyUpdate
    const cancelEdit = document.createElement('button')
    cancelEdit.type = 'button'
    cancelEdit.className = 'quiet'
    cancelEdit.textContent = messages.cancel
    apply.addEventListener('click', () => {
      const next = versionInput.value.trim()
      if (next === '' || next === plugin.version) {
        onDone()
        return
      }
      if (!VERSION_PATTERN.test(next)) {
        status.textContent = messages.invalidVersion
        return
      }
      editor.remove()
      void run(
        () => api.plugins.update(plugin.name, next),
        message('updating', { name: plugin.name }),
      ).finally(onDone)
    })
    cancelEdit.addEventListener('click', () => {
      editor.remove()
      onDone()
    })
    row.append(versionInput, apply, cancelEdit)
    editor.append(label, row)
    item.append(editor)
    versionInput.focus()
    versionInput.select()
  }

  async function render() {
    const plugins = await api.plugins.list()
    list.replaceChildren(...plugins.map(plugin => {
      const item = document.createElement('li')
      const identity = document.createElement('span')
      const version = document.createElement('span')
      version.className = 'package-version'
      version.textContent = plugin.version
      identity.append(document.createTextNode(plugin.name), version)
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = messages.remove
      remove.addEventListener('click', () => {
        if (!window.confirm(message('confirmRemove', { name: plugin.name }))) return
        void run(
          () => api.plugins.remove(plugin.name),
          message('removing', { name: plugin.name }),
        )
      })
      const update = document.createElement('button')
      update.type = 'button'
      update.textContent = messages.update
      update.addEventListener('click', () => {
        if (item.querySelector('.update-editor') !== null) return
        setBusy(true, message('updating', { name: plugin.name }))
        renderUpdateEditor(item, plugin, () => { setBusy(false, status.textContent) })
      })
      const actions = document.createElement('span')
      actions.className = 'package-actions'
      actions.append(update, remove)
      item.append(identity, actions)
      return item
    }))
    empty.hidden = plugins.length !== 0
  }

  async function run(operation, statusMessage) {
    setBusy(true, statusMessage)
    try {
      await operation()
      await render()
      status.textContent = messages.operationComplete
    } catch (error) {
      status.textContent = displayError(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  async function load(statusMessage, success) {
    setBusy(true, statusMessage)
    try {
      await render()
      status.textContent = success
    } catch (error) {
      status.textContent = displayError(error)
    } finally {
      setBusy(false, status.textContent)
    }
  }

  const renderUpdateState = (state) => {
    switch (state.phase) {
      case 'checking':
        updateStatus.textContent = messages.checkingForUpdates
        installUpdate.disabled = true
        return
      case 'available':
        updateStatus.textContent = message('updateReleaseAvailable', { version: state.version ?? '' })
        installUpdate.disabled = !packaged
        return
      case 'installing':
        updateStatus.textContent = typeof state.percent === 'number'
          ? message('downloadingUpdate', { version: state.version ?? '', percent: String(state.percent) })
          : message('updating', { name: state.version ?? '' })
        installUpdate.disabled = true
        return
      case 'ready':
        updateStatus.textContent = messages.operationComplete
        installUpdate.disabled = true
        return
      case 'error':
        updateStatus.textContent = state.message ?? messages.unknownError
        installUpdate.disabled = true
        return
      default:
        updateStatus.textContent = messages.updateCurrent
        installUpdate.disabled = true
    }
  }

  async function refreshUpdates(statusMessage) {
    updateStatus.textContent = statusMessage
    try {
      renderUpdateState(await api.updates.check())
    } catch (error) {
      updateStatus.textContent = displayError(error)
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const spec = input.value.trim()
    if (spec === '') return
    void run(async () => {
      await api.plugins.add(spec)
      input.value = ''
    }, message('installing', { spec }))
  })
  refresh.addEventListener('click', () => void load(messages.refreshing, messages.refreshed))
  checkUpdates.addEventListener('click', () => void refreshUpdates(messages.checkingForUpdates))
  installUpdate.addEventListener('click', () => {
    installUpdate.disabled = true
    void api.updates.install().catch((error) => {
      updateStatus.textContent = displayError(error)
    })
  })
  api.updates.subscribe(renderUpdateState)

  await load(messages.loadingPlugins, '')
  try {
    const version = await api.updates.version()
    currentVersion.textContent = message('currentVersion', { version })
  } catch (error) {
    currentVersion.textContent = displayError(error)
  }
  renderUpdateState({ phase: 'idle' })
}

void main()
