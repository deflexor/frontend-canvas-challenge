import { chromium } from 'playwright-core';

// Опциональный сценарий проверки в браузере; не входит в npm test.
// Запуск: npm i -D playwright-core, затем задайте CHROMIUM — путь к chrome/chromium:
// CHROMIUM=~/.cache/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell node e2e/smoke.mjs
const executablePath = process.env.CHROMIUM;
const API = process.env.API_BASE ?? 'http://localhost:4001';

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push('pageerror: ' + error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push('console: ' + message.text());
});

const step = (name) => console.log('== ' + name);

step('открываем приложение');
await page.goto(process.env.WEB_BASE ?? 'http://localhost:5173/');
await page.getByLabel('Название нового пространства').fill('Смоук-пространство');
await page.getByRole('button', { name: 'Создать и открыть' }).click();
await page.waitForSelector('.react-flow', { timeout: 10000 });
console.log('канвас открыт');

step('добавляем три ноды');
for (const type of ['Текст', 'Генератор', 'Результат']) {
  await page.getByRole('button', { name: `+ ${type}` }).click();
}
await page.waitForFunction(() => document.querySelectorAll('.react-flow__node').length === 3);
console.log('ноды: ' + (await page.locator('.react-flow__node').count()));

step('вводим текст (интерфейс обновляется сразу)');
const textarea = page.locator('.node--prompt textarea');
await textarea.fill('Горы на рассвете');
console.log('текст: ' + (await textarea.inputValue()));

step('соединяем порты перетаскиванием');
const center = async (selector) => {
  const box = await page.locator(selector).boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const promptOut = await center('.node--prompt .react-flow__handle.source');
const genIn = await center('.node--generator .react-flow__handle.target');
const genOut = await center('.node--generator .react-flow__handle.source');
const resIn = await center('.node--result .react-flow__handle.target');
console.log(
  `handles: out=(${promptOut.x | 0},${promptOut.y | 0}) in=(${genIn.x | 0},${genIn.y | 0})`,
);
for (const [from, to] of [
  [promptOut, genIn],
  [genOut, resIn],
]) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 12 });
  await page.mouse.up();
}
await page.waitForFunction(
  () => document.querySelectorAll('.react-flow__edge').length === 2,
  null,
  { timeout: 5000 },
);
console.log('связей: ' + (await page.locator('.react-flow__edge').count()));

step('ждём автосохранение и статус «Сохранено»');
await page.waitForFunction(
  () => document.querySelector('.topbar .status')?.textContent?.includes('Сохранено'),
  null,
  { timeout: 8000 },
);
console.log('статус: ' + (await page.locator('.topbar .status').textContent()).trim());

step('запускаем генерацию');
await page.getByRole('button', { name: 'Сгенерировать' }).click();
await page.waitForSelector('.node--result img', { timeout: 15000 });
const imgSrc = await page.locator('.node--result img').getAttribute('src');
console.log('картинка: ' + imgSrc);

step('перезагрузка: граф и результат восстанавливаются');
await page.reload();
await page.waitForSelector('.react-flow', { timeout: 10000 });
await page.waitForFunction(
  () => document.querySelectorAll('.react-flow__node').length === 3,
  null,
  { timeout: 8000 },
);
await page.waitForSelector('.node--result img', { timeout: 8000 });
const textAfter = await page.locator('.node--prompt textarea').inputValue();
console.log('после перезагрузки текст: ' + textAfter);
console.log(
  'после перезагрузки картинка: ' + (await page.locator('.node--result img').getAttribute('src')),
);

step('сценарий отказа и повтор');
await page.getByLabel('Сценарий проверки').selectOption('failure');
await page.getByRole('button', { name: 'Сгенерировать' }).click();
await page.waitForSelector('.node--generator .node__alert', { timeout: 15000 });
console.log(
  'ошибка в ноде: ' +
    (await page.locator('.node--generator .node__alert').textContent()).trim().slice(0, 60),
);
await page.getByRole('button', { name: 'Повторить' }).first().click();
// повтор после серверного отказа создаёт новую генерацию — она тоже упадёт (сценарий всё ещё failure)
await page.waitForSelector('.node--generator .node__alert', { timeout: 15000 });
console.log(
  'повтор: ' +
    (await page.locator('.node--generator .node__alert').textContent()).trim().slice(0, 60),
);

step('несовместимая связь не создаётся: выход текста → вход результата');
const promptOut2 = await center('.node--prompt .react-flow__handle.source');
const resIn2 = await center('.node--result .react-flow__handle.target');
await page.mouse.move(promptOut2.x, promptOut2.y);
await page.mouse.down();
await page.mouse.move(resIn2.x, resIn2.y, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(300);
const edgesAfterInvalid = await page.locator('.react-flow__edge').count();
console.log('связей после запрещённой попытки: ' + edgesAfterInvalid + ' (ожидалось 2)');
if (edgesAfterInvalid !== 2) throw new Error('запрещённая связь создалась!');

step('удаление генератора убирает его связи');
await page.locator('.node--generator .node__remove').click();
await page.waitForFunction(
  () => document.querySelectorAll('.react-flow__node').length === 2,
  null,
  { timeout: 5000 },
);
await page.waitForFunction(
  (expected) => document.querySelectorAll('.react-flow__edge').length === expected,
  0,
  { timeout: 5000 },
);
console.log(
  'нод: ' +
    (await page.locator('.react-flow__node').count()) +
    ', связей: ' +
    (await page.locator('.react-flow__edge').count()),
);
await page.waitForFunction(
  () => document.querySelector('.topbar .status')?.textContent?.includes('Сохранено'),
  null,
  { timeout: 8000 },
);

step('проверка графа на сервере');
const spacePath = await page.evaluate(() => localStorage.getItem('canvas.spaceId'));
const graph = await (await fetch(`${API}/api/spaces/${spacePath}/graph`)).json();
console.log('на сервере нод: ' + graph.nodes.length + ', связей: ' + graph.edges.length);
const promptNode = graph.nodes.find((n) => n.type === 'prompt');
console.log('текст на сервере: ' + promptNode.data.text);
console.log(
  'нет служебных полей: ' + String(!('selected' in promptNode) && !('measured' in promptNode)),
);

if (errors.length) {
  console.log('\nОШИБКИ КОНСОЛИ/СТРАНИЦЫ:');
  for (const error of errors) console.log('  ' + error);
} else {
  console.log('\nошибок в консоли нет');
}
await browser.close();
