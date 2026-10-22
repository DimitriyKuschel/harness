import { locale } from '../../i18n';
import { en, type Prompts } from './en';
import { ru } from './ru';

/** Agent instructions in the UI language, so plans, summaries and routing reasons come back in it too. */
export function prompts(): Prompts {
  return locale() === 'ru' ? ru : en;
}
