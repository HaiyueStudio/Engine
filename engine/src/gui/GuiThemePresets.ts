import {DEFAULT_GUI_THEME, type GuiTheme} from './GuiTypes';

/** Plain data only: presets never import widgets or another package. */
export function guiThemePreset(mode: 'dark' | 'light' | 'legacy', density: NonNullable<GuiTheme['density']> = 'comfortable'): GuiTheme {
  if (!['dark','light','legacy'].includes(mode) || !['compact','comfortable','touch'].includes(density)) throw new TypeError('Invalid GUI theme preset.');
  const light = mode === 'light';
  if (mode === 'legacy') return {...DEFAULT_GUI_THEME, colors: {...DEFAULT_GUI_THEME.colors}};
  return {fontFamily: 'sans-serif', fontSize: density === 'compact' ? 12 : density === 'touch' ? 16 : 14,
    fontWeight: 400, lineHeight: density === 'compact' ? 18 : density === 'touch' ? 24 : 20,
    radius: 6, density, spacing: density === 'compact' ? 4 : density === 'touch' ? 10 : 8, motionScale: 1,
    colors: light ? {
      text:'#183247',textMuted:'#5f7c92',primary:'#55b4da',danger:'#d43852',background:'#edf8ff',surface:'#f7fbff',border:'#c7ddea',hover:'#e1f1fa',active:'#3197bf',disabled:'#dde8ee',
      elevated:'#ffffff',input:'#ffffff',onPrimary:'#ffffff',disabledText:'#93a6b4',focus:'#3aa6d1',thumb:'#ffffff',success:'#20845c',warning:'#a66c14',overlay:'#142a4266',shadow:'#1a456126',
    } : {
      text:'#eef0ff',textMuted:'#a9add4',primary:'#8177f2',danger:'#ed6c83',background:'#0c1029',surface:'#10132f',border:'#343765',hover:'#252851',active:'#554cc6',disabled:'#292c48',
      elevated:'#181a40',input:'#0c1029',onPrimary:'#ffffff',disabledText:'#666c95',focus:'#9c8fff',thumb:'#ffffff',success:'#57c89b',warning:'#efc16c',overlay:'#030615aa',shadow:'#00000066',
    }};
}
