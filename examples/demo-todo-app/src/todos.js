export function createTodoList() {
  const items = [];
  let nextId = 1;

  return {
    add(title) {
      const text = String(title ?? '').trim();
      if (!text) throw new Error('Title is required');
      const todo = { id: nextId++, title: text, done: false };
      items.push(todo);
      return { ...todo };
    },

    complete(id) {
      const todo = items.find((item) => item.id === id);
      if (!todo) throw new Error(`Todo ${id} not found`);
      todo.done = true;
      return { ...todo };
    },

    list() {
      return items.map((item) => ({ ...item }));
    },
  };
}
