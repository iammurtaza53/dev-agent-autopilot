import test from 'node:test';
import assert from 'node:assert/strict';
import { createTodoList } from '../src/todos.js';

test('add trims the title and starts open', () => {
  const todos = createTodoList();
  assert.deepEqual(todos.add('  Buy milk '), { id: 1, title: 'Buy milk', done: false });
});

test('add rejects an empty title', () => {
  assert.throws(() => createTodoList().add('   '), /Title is required/);
});

test('complete marks a todo as done', () => {
  const todos = createTodoList();
  const { id } = todos.add('Write tests');
  assert.equal(todos.complete(id).done, true);
  assert.equal(todos.list()[0].done, true);
});

test('complete rejects an unknown id', () => {
  assert.throws(() => createTodoList().complete(42), /Todo 42 not found/);
});

test('list returns copies, not the internal items', () => {
  const todos = createTodoList();
  todos.add('Read docs');
  todos.list()[0].title = 'changed';
  assert.equal(todos.list()[0].title, 'Read docs');
});
