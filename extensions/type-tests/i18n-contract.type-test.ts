import { I18n, bindI18nImage, bindI18nText, createI18nTextureLoader, type LocalePack } from '@haiyue/extensions/i18n';
import { GuiLabel, GuiImage, GuiButton } from '@haiyue/engine/gui';
import type { AssetManager } from '@haiyue/engine/assets';
const pack: LocalePack = { schemaVersion: 1, locale: 'en', messages: { title: 'PLAY', count: { one: '{count} coin', other: '{count} coins' } }, assets: { logo: 'logo.png' } };
const runtime = new I18n({ locale: 'en', fallbackLocale: 'en' });
runtime.register(pack);
bindI18nText(runtime, new GuiLabel(), 'title').setParams({ count: 2 });
bindI18nText(runtime, new GuiButton(), 'title');
declare const assets: AssetManager;
const image = bindI18nImage(runtime, new GuiImage(), 'logo', { textKey: 'title', load: createI18nTextureLoader(assets, 'https://game.test/') });
void image.ready;
// @ts-expect-error Objects are not valid interpolation values.
runtime.text('title', { count: {} });
// @ts-expect-error Plurals require an other form.
const invalid: LocalePack = { schemaVersion: 1, locale: 'en', messages: { count: { one: 'coin' } } };
void invalid;
