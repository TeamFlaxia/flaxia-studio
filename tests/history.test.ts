import assert from 'node:assert/strict';
import test from 'node:test';
import { HistoryService, type Command } from '../src/lib/history.ts';

function valueCommand(value: { current: string }, next: string, label = 'Set value'): Command {
  const previous = value.current;
  return {
    id: `set-${next}`,
    label,
    execute: () => {
      value.current = next;
    },
    undo: () => {
      value.current = previous;
    },
  };
}

test('run applies a command and undo/redo restore it', async () => {
  const value = { current: 'a' };
  const history = new HistoryService();

  await history.run(valueCommand(value, 'b'));
  assert.equal(value.current, 'b');
  assert.equal(history.state.canUndo, true);
  assert.equal(history.state.canRedo, false);
  assert.equal(history.state.undoLabel, 'Set value');

  assert.equal(await history.undo(), true);
  assert.equal(value.current, 'a');
  assert.equal(history.state.canRedo, true);

  assert.equal(await history.redo(), true);
  assert.equal(value.current, 'b');
  assert.equal(history.state.canUndo, true);
});

test('undo and redo on an empty stack are no-ops', async () => {
  const history = new HistoryService();
  assert.equal(await history.undo(), false);
  assert.equal(await history.redo(), false);
  assert.equal(history.state.depth, 0);
});

test('a new command clears the redo stack', async () => {
  const value = { current: 'a' };
  const history = new HistoryService();
  await history.run(valueCommand(value, 'b'));
  await history.undo();
  await history.run(valueCommand(value, 'c'));
  assert.equal(history.state.canRedo, false);
  assert.equal(value.current, 'c');
  await history.undo();
  assert.equal(value.current, 'a');
});

test('commands with the same merge key collapse into one step', async () => {
  const value = { current: 0 };
  const history = new HistoryService();
  const makeCommand = (next: number): Command => {
    const previous = value.current;
    return {
      id: `add-${next}`,
      label: 'Adjust',
      mergeKey: 'adjust-value',
      execute: () => {
        value.current = next;
      },
      undo: () => {
        value.current = previous;
      },
      merge: (later) => ({
        id: 'adjust-merged',
        label: 'Adjust',
        mergeKey: 'adjust-value',
        execute: later.execute,
        undo: () => {
          value.current = previous;
        },
        merge: later.merge,
      }),
    };
  };

  await history.run(makeCommand(1));
  await history.run(makeCommand(2));
  assert.equal(value.current, 2);
  assert.equal(history.state.depth, 1);

  await history.undo();
  assert.equal(value.current, 0);
});

test('listeners receive state changes and can unsubscribe', async () => {
  const history = new HistoryService();
  const states: boolean[] = [];
  const unsubscribe = history.onChange((state) => states.push(state.canUndo));
  const command = valueCommand({ current: 'x' }, 'y');
  await history.run(command);
  unsubscribe();
  await history.run(command);
  assert.deepEqual(states, [false, true]);
});

test('history respects the configured limit', async () => {
  const value = { current: '' };
  const history = new HistoryService(2);
  await history.run(valueCommand(value, 'a'));
  await history.run(valueCommand(value, 'b'));
  await history.run(valueCommand(value, 'c'));
  assert.equal(history.state.depth, 2);
  await history.undo();
  await history.undo();
  assert.equal(value.current, 'a');
});

test('a failed execute is not recorded', async () => {
  const history = new HistoryService();
  await assert.rejects(
    history.run({
      id: 'broken',
      label: 'Broken',
      execute: () => {
        throw new Error('nope');
      },
      undo: () => undefined,
    }),
    /nope/,
  );
  assert.equal(history.state.depth, 0);
});

test('push records an already executed command', async () => {
  const value = { current: 'a' };
  const history = new HistoryService();
  const command = valueCommand(value, 'b');
  command.execute();
  await history.push(command);
  assert.equal(history.state.depth, 1);
  await history.undo();
  assert.equal(value.current, 'a');
});
