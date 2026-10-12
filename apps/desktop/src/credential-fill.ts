/** Main-process approval and isolated-world filling; secrets never enter results or diagnostic messages. */
import { dialog, type BrowserWindow, type WebContents, systemPreferences } from 'electron'
import type { CredentialVault } from './credential-vault.ts'
import { generateTotp, parseTotpUri } from './totp.ts'
import type { FillFieldType, CredentialFillResult } from '@deepseek-ai/dsh-client-ui-sidebar-browser/types'
import { credentialOrigin } from './credential-validation.ts'

/** Fields selected by a user for an already owned guest. */
export interface FillRequest {
  readonly fields: readonly FillFieldType[]
  readonly credentialId: string
}

// 0 is the page world; 999 is reserved by Electron for context isolation.
const CREDENTIAL_WORLD = 1001
const FIELD_LABELS: Record<FillFieldType, string> = { username: '用户名', password: '密码', totp: '动态验证码' }

const FILL_SCRIPT = `((value, field, origin) => {
  if (location.origin !== origin) return false;
  const visible = el => !el.disabled && !el.readOnly && el.type !== 'hidden'
    && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
    && getComputedStyle(el).display !== 'none';
  const inputs = Array.from(document.querySelectorAll('input'));
  const password = inputs.find(el => el.type === 'password' && visible(el));
  let target;
  if (field === 'password') target = password;
  if (field === 'username') {
    target = inputs.find(el => el.autocomplete === 'username' && visible(el)
      && (!password || el.form === password.form));
    if (!target && password && password.form) {
      target = inputs.filter(el => el.form === password.form && ['text', 'email', 'tel'].includes(el.type)
        && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING) && visible(el)).at(-1);
    }
  }
  if (field === 'totp') {
    target = inputs.find(el => el.autocomplete === 'one-time-code' && visible(el));
    if (!target) target = inputs.find(el => !['password', 'submit', 'button', 'checkbox', 'radio'].includes(el.type)
      && visible(el) && /otp|code|totp|验证码|校验码/i.test([el.name, el.id, el.placeholder].join(' ')));
  }
  if (!target || location.origin !== origin) return false;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(target, value);
  target.dispatchEvent(new Event('input', { bubbles: true }));
  target.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})`

function assertNever(_field: never): never {
  throw new Error('Unsupported credential field')
}

function literal(value: string): string {
  return JSON.stringify(value).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

/** Prompts for each fill, then decrypts and injects only the selected fields without submitting. */
export class CredentialFiller {
  /** @param vault - main-process-only encrypted store. */
  constructor(private readonly vault: CredentialVault) {}

  /**
   * @param guest - lease-owned guest. @param request - validated entry and fields. @param mainWindow - approval parent.
   * @returns field names only; rejects origin changes, denial and biometric failures.
   */
  async fill(guest: Pick<WebContents, 'getURL' | 'executeJavaScriptInIsolatedWorld'>,
    request: FillRequest, mainWindow: BrowserWindow): Promise<CredentialFillResult> {
    await this.vault.load()
    const entry = this.vault.list().find(item => item.id === request.credentialId)
    if (entry === undefined) throw new Error('Credential entry not found')
    const checkOrigin = (): void => {
      if (credentialOrigin(guest.getURL()) !== entry.origin) {
        throw new Error('Origin mismatch: 页面站点与凭据站点不一致，已停止代填')
      }
    }
    checkOrigin()
    const approval = await dialog.showMessageBox(mainWindow, {
      type: 'question', title: '批准填入凭据', message: '是否向当前页面填入凭据？',
      detail: `站点：${entry.origin}\n条目：${entry.label}\n字段：${request.fields.map(field => FIELD_LABELS[field]).join('、')}`
        + ` (${request.fields.join(', ')})\n不会自动提交登录表单`,
      buttons: ['批准', '取消'], defaultId: 1, cancelId: 1,
    })
    if (approval.response !== 0) throw new Error('Fill request was not approved')
    if (process.platform === 'darwin' && systemPreferences.canPromptTouchID()) {
      try { await systemPreferences.promptTouchID(`批准向 ${entry.origin} 填入凭据`) } catch (_error) {
        throw new Error('触控 ID 验证失败，已停止代填')
      }
    }
    checkOrigin()
    const credential = await this.vault.getSecrets(entry.id)
    if (credential === null) throw new Error('Credential entry not found')
    const filled: FillFieldType[] = []
    const notFound: FillFieldType[] = []
    for (const field of request.fields) {
      let value: string
      switch (field) {
        case 'username': value = entry.username; break
        case 'password': value = credential.password; break
        case 'totp': {
          if (!credential.totpSecret) { notFound.push(field); continue }
          value = generateTotp(credential.totpSecret.startsWith('otpauth:')
            ? parseTotpUri(credential.totpSecret) : { secret: credential.totpSecret })
          break
        }
        default: assertNever(field)
      }
      // Recheck after every await, including decryption and a previous field's DOM events.
      checkOrigin()
      let result: unknown
      try {
        result = await guest.executeJavaScriptInIsolatedWorld(CREDENTIAL_WORLD, [{
          code: `${FILL_SCRIPT}(${literal(value)}, ${literal(field)}, ${literal(entry.origin)})`,
        }])
      } catch (_error) {
        // Guest exceptions may quote the source containing secrets. Never log or forward them.
        throw new Error('凭据填写失败，请重新检查页面并重试')
      }
      if (result === true) filled.push(field)
      else notFound.push(field)
    }
    return { filled, notFound }
  }
}
