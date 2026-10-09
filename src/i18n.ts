import * as OpenCC from 'opencc-js/cn2t';
/**
 * Supported locales. Tags carry a region, not only a script: zh-HK copy uses Hong Kong wording,
 * not only Traditional glyphs. A later zh-TW gets its own term list on the same glyph set.
 */
export const locales = ['en', 'zh-CN', 'zh-HK'] as const;
export type Locale = typeof locales[number];
/** Text written by hand. zh-HK is derived from zh-CN, see toHongKong. */
export type Localized = Record<'en' | 'zh-CN', string>;
/** Hong Kong wording, applied after the Simplified to Traditional conversion. */
const hongKongTerms: [string, string][] = [
  ['賬號', '帳戶'], ['賬戶', '帳戶'], ['賬單', '帳單'], ['退出登錄', '登出'], ['登錄', '登入'], ['鏈接', '連結'], ['郵箱', '電郵'],
  ['創建', '建立'], ['文檔', '文件'], ['代碼', '程式碼'], ['設置', '設定'], ['默認', '預設'], ['當前', '目前'], ['字符串', '字串'],
  ['字符', '字元'], ['內存', '記憶體'], ['通過', '透過'], ['運行', '執行'], ['臺', '台'], ['菜單', '選單'], ['打開', '開啟'],
  ['選中', '選取'], ['文本', '文字'], ['聯繫', '聯絡'], ['信息', '資訊'], ['支持', '支援'], ['兼容', '相容'], ['字段', '欄位'],
  ['接口', '介面'], ['響應', '回應'], ['示例', '範例'], ['集成', '整合'], ['協議', '協定'], ['哈希', '雜湊'], ['搜索', '搜尋'],
  ['用戶名', '用戶名稱'], ['端口', '連接埠'], ['自定義', '自訂'], ['標籤頁', '分頁'], ['環境變量', '環境變數'], ['獲取', '取得'], ['保存', '儲存'],
  ['界面', '介面'], ['操作系統', '作業系統'], ['設備', '裝置'], ['添加', '新增'], ['性能', '效能'], ['只讀', '唯讀'], ['服務器', '伺服器'], ['弔銷', '吊銷'],
];
/** zh-CN text in Traditional glyphs (Taiwan glyph set, e.g. 戶 and 說) with Hong Kong wording. */
export const toHongKong = OpenCC.ConverterFactory(OpenCC.Locale.from.cn, OpenCC.Locale.to.tw, [hongKongTerms]);
export function localize(text: Localized, locale: Locale) { return locale === 'zh-HK' ? toHongKong(text['zh-CN']) : text[locale]; }
/** Maps a BCP 47 tag to the closest supported locale through its likely script: zh-TW, zh-MO and zh-Hant read zh-HK; zh, zh-SG and zh-Hans read zh-CN. */
export function matchLocale(tag?: string | null): Locale | undefined {
  if (!tag) return;
  let locale: Intl.Locale;
  try { locale = new Intl.Locale(tag).maximize(); } catch { return; }
  if (locale.language === 'en') return 'en';
  if (locale.language === 'zh') return locale.script === 'Hant' ? 'zh-HK' : 'zh-CN';
}
/** Chooses a locale from an explicit `lang` value, then Accept-Language by q-value; English otherwise. */
export function pickLocale(lang?: string | null, acceptLanguage?: string | null): Locale {
  const ranges = (acceptLanguage || '').split(',').map(part => {
    const [tag, ...params] = part.split(';').map(value => value.trim());
    const q = params.find(param => param.startsWith('q='));
    return { tag, q: q ? Number(q.slice(2)) : 1 };
  }).filter(range => range.q > 0).sort((a, b) => b.q - a.q);
  for (const tag of [lang, ...ranges.map(range => range.tag)]) { const locale = matchLocale(tag); if (locale) return locale; }
  return 'en';
}
