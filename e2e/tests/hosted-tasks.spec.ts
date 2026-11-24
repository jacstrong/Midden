/**
 * Task management end to end: a lead imports a playbook and shares it out, analysts work the
 * board, the approval gate holds until the approver signs off, mentions reach the bell, and a
 * task linked to a restricted case disappears for people outside it.
 *
 * Runs in Chromium and WebKit against the same server, so every name carries a suffix.
 * It only uses ann and bob, because the collaboration spec counts users.
 */
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { ADMIN, BASE, H, apiLogin, ensureUser, userPage } from './helpers';

const ANN = { username: 'ann', password: 'ann-password-123' };
const BOB = { username: 'bob', password: 'bob-password-123' };

interface TaskJson {
  id: string;
  num: number;
  title: string;
  statusId: string;
  assignees: string[];
}

let ids: { ann: string; bob: string };
let teamName = '';
let S = '';

/** The browser's own session, so API calls act as whoever is signed in on that page. */
const api = async <T>(page: Page, method: string, url: string, data?: object): Promise<T> => {
  const r = await page.request.fetch(`${BASE}${url}`, {
    method,
    headers: H,
    ...(data ? { data } : {}),
  });
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
  return (await r.json()) as T;
};

/** A board column by its heading. */
async function column(page: Page, name: string) {
  const heads = await page.locator('.bcolhead .bname').allTextContents();
  const i = heads.indexOf(name);
  expect(i, `no "${name}" column in ${heads.join(', ')}`).toBeGreaterThanOrEqual(0);
  return page.getByTestId('board-col').nth(i);
}

async function adminCall(request: APIRequestContext, method: string, url: string, data?: object) {
  const r = await request.fetch(`${BASE}${url}`, { method, headers: H, ...(data ? { data } : {}) });
  expect(r.status(), `${method} ${url}: ${await r.text()}`).toBeLessThan(300);
  return r.json();
}

test.describe('task management', () => {
  test.beforeAll(async ({ request }, info) => {
    S = `${info.project.name}-${Date.now().toString(36)}`;
    await ensureUser(request, ANN.username, ANN.password);
    await ensureUser(request, BOB.username, BOB.password);
    await apiLogin(request, ADMIN.username, ADMIN.password);
    const users = (await adminCall(request, 'GET', '/api/users')).users as {
      id: string;
      username: string;
    }[];
    ids = {
      ann: users.find((u) => u.username === 'ann')!.id,
      bob: users.find((u) => u.username === 'bob')!.id,
    };
    teamName = `Host ${S}`;
    const team = (await adminCall(request, 'POST', '/api/teams', { name: teamName })).team;
    await adminCall(request, 'PUT', `/api/teams/${team.id}/members/${ids.ann}`, { role: 'lead' });
    await adminCall(request, 'PUT', `/api/teams/${team.id}/members/${ids.bob}`, {
      role: 'member',
    });
    await request.post(`${BASE}/api/auth/logout`, { headers: H });
  });

  test('a lead imports a playbook and distributes it; an analyst drags a card and both see it', async ({
    browser,
  }) => {
    const ann = await userPage(browser, ANN.username, ANN.password);
    const bob = await userPage(browser, BOB.username, BOB.password);
    const titles = [
      'Pull DNS logs',
      'Baseline services',
      'Check scheduled tasks',
      'Hunt lateral movement',
    ].map((t) => `${t} ${S}`);
    const csv = [
      'key,title,status,priority,due,blocked_by,checklist',
      `1,${titles[0]},To do,high,+1d,,Export;Hash`,
      `2,${titles[1]},To do,medium,+2d,1,`,
      `3,${titles[2]},To do,low,,,`,
      `4,${titles[3]},To do,urgent,,,`,
    ].join('\n');

    await ann.getByTestId('nav-tasks').click();
    await ann.getByTestId('task-import').click();
    const wizard = ann.getByRole('dialog');
    await wizard.getByRole('radio', { name: 'A CSV file' }).click();
    await wizard.getByTestId('import-file').setInputFiles({
      name: 'hunt.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await wizard.getByTestId('import-run-name').fill(`Hunt ${S}`);
    await wizard
      .locator('.impnew label')
      .filter({ hasText: 'Team' })
      .locator('select')
      .selectOption({ label: teamName });
    await expect(wizard.getByTestId('import-preview')).toContainText(titles[3]!);
    await wizard.getByTestId('import-go').click();
    await expect(ann).toHaveURL(/#\/tasks\/run:run_[^/]+$/);
    const runId = /run:(run_[^/]+)/.exec(ann.url())![1]!;
    await expect(ann.getByTestId('task-card')).toHaveCount(4);

    // Pick every card and share them out evenly between the two analysts.
    for (const box of await ann.getByTestId('task-card').getByRole('checkbox').all())
      await box.check();
    await expect(ann.getByTestId('bulk-bar')).toContainText('4 tasks selected');
    await ann.getByTestId('bulk-distribute').click();
    const deal = ann.getByRole('dialog');
    // A lead's one team is filled in for them.
    await expect(deal.getByRole('button', { name: 'Remove ann' })).toBeVisible();
    await expect(deal.getByRole('button', { name: 'Remove bob' })).toBeVisible();
    // Round-robin, so the split doesn't depend on work left over from earlier runs.
    await deal.getByRole('radio', { name: 'Round-robin' }).click();
    const gets = deal.getByTestId('distribute-preview').locator('tbody tr td:nth-child(2)');
    await expect(gets).toHaveText(['2', '2']);
    await deal.getByTestId('distribute-apply').click();
    await expect(ann.getByTestId('toast').filter({ hasText: 'Distributed 4 tasks' })).toBeVisible();
    const { tasks } = await api<{ tasks: TaskJson[] }>(ann, 'GET', `/api/tasks?run=${runId}`);
    expect(tasks.map((t) => t.assignees.length)).toEqual([1, 1, 1, 1]);
    expect(tasks.filter((t) => t.assignees[0] === ids.bob)).toHaveLength(2);

    // Bob isn't a lead: he can pick several cards, but not share them out.
    await bob.goto(`${BASE}/#/tasks/run:${runId}`);
    await expect(bob.getByTestId('task-card')).toHaveCount(4);
    const boxes = bob.getByTestId('task-card').getByRole('checkbox');
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await expect(bob.getByTestId('bulk-bar')).toContainText('2 tasks selected');
    await expect(bob.getByTestId('bulk-distribute')).toHaveCount(0);
    await boxes.nth(0).uncheck();
    await boxes.nth(1).uncheck();

    // Bob drags one of his cards to In progress; Ann's board follows without a reload.
    const mine = tasks.find((t) => t.assignees[0] === ids.bob)!;
    const card = bob.getByTestId('task-card').filter({ hasText: mine.title });
    await card.dragTo(await column(bob, 'In progress'));
    await expect((await column(bob, 'In progress')).getByText(mine.title)).toBeVisible();
    await expect((await column(ann, 'In progress')).getByText(mine.title)).toBeVisible();
    await expect((await column(ann, 'To do')).getByTestId('task-card')).toHaveCount(3);

    await ann.context().close();
    await bob.context().close();
  });

  test('a task with an approver cannot be done until the approver signs off', async ({
    browser,
  }) => {
    const ann = await userPage(browser, ANN.username, ANN.password);
    const bob = await userPage(browser, BOB.username, BOB.password);
    const { task } = await api<{ task: TaskJson }>(ann, 'POST', '/api/tasks', {
      title: `Accept risk on legacy SMB ${S}`,
      assignees: [ids.ann],
      approverId: ids.bob,
    });

    await ann.goto(`${BASE}/#/tasks/mine/t/${task.num}`);
    const drawer = ann.getByTestId('task-drawer');
    await expect(drawer).toHaveAttribute('aria-label', `Task T-${task.num}`);
    await expect(drawer.getByTestId('approval')).toContainText('Waiting for bob');
    await drawer.locator('#tdStatus').selectOption({ label: 'Done' });
    await expect(ann.getByTestId('toast').filter({ hasText: /needs approval/ })).toBeVisible();
    await expect(drawer.locator('#tdStatus option:checked')).not.toHaveText('Done');

    await bob.goto(`${BASE}/#/tasks/approvals/t/${task.num}`);
    const bobDrawer = bob.getByTestId('task-drawer');
    await bobDrawer.getByPlaceholder(/Optional comment/).fill('Accepted for this hunt');
    await bobDrawer.getByTestId('approve').click();
    await expect(bobDrawer.getByTestId('approval')).toContainText(/approved/i);

    // Ann's drawer hears about the decision live, and now the task can close.
    await expect(drawer.getByTestId('approval')).toContainText(/approved/i);
    await drawer.locator('#tdStatus').selectOption({ label: 'Done' });
    await expect(drawer.locator('#tdStatus option:checked')).toHaveText('Done');
    const after = await api<{ task: TaskJson }>(ann, 'GET', `/api/tasks/${task.id}`);
    expect(after.task.statusId).toBe(await drawer.locator('#tdStatus').inputValue());

    await ann.context().close();
    await bob.context().close();
  });

  test('a mention in a comment rings the bell and opens the task', async ({ browser }) => {
    const ann = await userPage(browser, ANN.username, ANN.password);
    const bob = await userPage(browser, BOB.username, BOB.password);
    const { task } = await api<{ task: TaskJson }>(ann, 'POST', '/api/tasks', {
      title: `Review beacon timing ${S}`,
      assignees: [ids.ann],
    });
    await api(bob, 'POST', '/api/notifications/read', { all: true });
    await bob.reload();
    await expect(bob.getByTestId('bell-count')).toHaveCount(0);

    await ann.goto(`${BASE}/#/tasks/mine/t/${task.num}`);
    const drawer = ann.getByTestId('task-drawer');
    await drawer.getByPlaceholder(/Comment…/).fill('@bob can you check the jitter on this one?');
    await drawer.getByTestId('comment-post').click();
    await expect(drawer.getByTestId('comment')).toContainText('check the jitter');

    await expect(bob.getByTestId('bell-count')).toHaveText('1');
    await bob.getByTestId('bell').click();
    const item = bob.getByTestId('notification').first();
    await expect(item).toContainText(`mentioned you on T-${task.num}`);
    await item.click();
    await expect(bob.getByTestId('task-drawer')).toHaveAttribute(
      'aria-label',
      `Task T-${task.num}`,
    );
    await expect(bob.getByTestId('bell-count')).toHaveCount(0);

    await ann.context().close();
    await bob.context().close();
  });

  test('linking a task to a restricted case hides it from people outside the case', async ({
    browser,
  }) => {
    const ann = await userPage(browser, ANN.username, ANN.password);
    const bob = await userPage(browser, BOB.username, BOB.password);
    const secret = (
      await api<{ case: { id: string } }>(ann, 'POST', '/api/cases', {
        name: `Insider ${S}`,
        restricted: true,
      })
    ).case.id;
    const { task } = await api<{ task: TaskJson }>(ann, 'POST', '/api/tasks', {
      title: `Interview the badge office ${S}`,
    });

    await bob.goto(`${BASE}/#/tasks/all`);
    const row = bob.getByTestId('task-row').filter({ hasText: task.title });
    await expect(row).toHaveCount(1);

    await api(ann, 'PATCH', `/api/tasks/${task.id}`, { caseId: secret });
    await expect(row).toHaveCount(0);
    const direct = await bob.request.get(`${BASE}/api/tasks/${task.id}`);
    expect(direct.status()).toBe(404);

    await ann.goto(`${BASE}/#/tasks/all`);
    await expect(ann.getByTestId('task-row').filter({ hasText: task.title })).toHaveCount(1);

    await ann.context().close();
    await bob.context().close();
  });
});
