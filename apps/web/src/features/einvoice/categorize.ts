/**
 * 依商店名稱猜類別。猜不到回 'other'，之後會出現在「需要處理」讓使用者整理。
 * 規則刻意保守：只放高信心關鍵字。
 */
const RULES: { category: string; pattern: RegExp }[] = [
  { category: 'food', pattern: /餐|飯|麵|食|咖啡|茶|飲|烘焙|麵包|甜點|麥當勞|肯德基|摩斯|星巴克|路易莎|85度|鼎泰豐|壽司|火鍋|燒肉|便當|小吃|coffee|cafe|bakery|kitchen/i },
  { category: 'transport', pattern: /中油|台亞|加油|停車|高鐵|台鐵|捷運|客運|uber|計程|租車|悠遊|一卡通|統聯|國光|parking|taxi/i },
  { category: 'home', pattern: /家樂福|全聯|大潤發|好市多|costco|愛買|水費|電費|瓦斯|台電|自來水|中華電信|台灣大哥大|遠傳|電信|寬頻|ikea|宜得利|特力屋|生活工場/i },
  { category: 'medical', pattern: /藥局|藥妝|診所|醫院|牙醫|眼科|中醫|屈臣氏|康是美|大樹|杏一|clinic|pharmacy/i },
  { category: 'shopping', pattern: /統一超商|7-?11|全家|萊爾富|OK超商|超商|便利商店|momo|蝦皮|pchome|博客來|uniqlo|zara|無印|誠品|寶雅|小北|momo|amazon|apple/i },
  { category: 'entertainment', pattern: /威秀|影城|電影|KTV|好樂迪|錢櫃|netflix|spotify|steam|遊戲|健身|world gym|運動中心/i },
  { category: 'education', pattern: /書局|書店|文具|補習|課程|udemy|hahow/i },
];

export function guessCategory(sellerName: string, items: string[], allowed: Set<string>): string {
  const hay = `${sellerName} ${items.join(' ')}`;
  for (const r of RULES) {
    if (allowed.has(r.category) && r.pattern.test(hay)) return r.category;
  }
  return allowed.has('other') ? 'other' : (allowed.values().next().value ?? 'other');
}
