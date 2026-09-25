export function registerBatchRoutes(app, { store, batchExecutor }) {
  // List tasks
  app.get('/api/v1/batch/tasks', async () => {
    const tasks = store.listBatchTasks(30);
    return { success: true, count: tasks.length, tasks };
  });

  // Get specific task
  app.get('/api/v1/batch/tasks/:id', async (req, res) => {
    const task = store.getBatchTask(req.params.id);
    if (!task) {
      res.status(404);
      return { success: false, message: 'Task not found' };
    }
    return { success: true, task };
  });

  // Create & launch task
  app.post('/api/v1/batch/tasks', async (req, res) => {
    const { title, task_type, target_site_id, payload, concurrency } = req.body || {};
    if (!title || !task_type) {
      res.status(400);
      return { success: false, message: 'title and task_type are required' };
    }

    try {
      const task = store.createBatchTask({
        title,
        task_type,
        target_site_id,
        payload: payload || {}
      });

      // Launch async in background
      batchExecutor.executeTask(task.id, { concurrency: concurrency || 5 }).catch(err => {
        console.error(`[MantaMan Batch] Task ${task.id} execution error:`, err.message);
      });

      store.recordAuditLog({
        actor: req.user?.username || 'admin',
        action: `batch_${task_type}`,
        target_type: 'batch_task',
        target_id: task.id,
        details: { title, target_site_id }
      });

      return { success: true, message: 'Batch task queued', task };
    } catch (err) {
      res.status(400);
      return { success: false, message: err.message };
    }
  });
}
