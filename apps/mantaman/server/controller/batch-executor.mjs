export class BatchExecutor {
  constructor(store, fleetManager) {
    this.store = store;
    this.fleetManager = fleetManager;
    this.runningTasks = new Set();
  }

  async executeTask(taskId, options = { concurrency: 5 }) {
    if (this.runningTasks.has(taskId)) {
      throw new Error('Task is already running');
    }

    const task = this.store.getBatchTask(taskId);
    if (!task) throw new Error('Task not found');

    this.runningTasks.add(taskId);
    this.store.updateBatchTaskProgress(taskId, { status: 'in_progress' });

    // Determine target hubs
    let targetHubs = [];
    if (task.target_site_id) {
      targetHubs = this.store.listHubs({ site_id: task.target_site_id, status: 'managed' });
    } else if (task.payload_json?.target_hub_ids) {
      targetHubs = task.payload_json.target_hub_ids
        .map(id => this.store.getHub(id))
        .filter(Boolean);
    } else {
      targetHubs = this.store.listHubs({ status: 'managed' });
    }

    const total = targetHubs.length;
    if (total === 0) {
      this.store.updateBatchTaskProgress(taskId, {
        status: 'completed',
        total_nodes: 0,
        successful_nodes: 0,
        failed_nodes: 0,
        log_entry: { message: `No target managed nodes found for ${task.task_type}. Completed with 0 nodes.`, level: 'warn' }
      });
      this.runningTasks.delete(taskId);
      return this.store.getBatchTask(taskId);
    }

    this.store.updateBatchTaskProgress(taskId, {
      total_nodes: total,
      log_entry: { message: `Targeting ${total} nodes for ${task.task_type}`, level: 'info' }
    });

    let successCount = 0;
    let failedCount = 0;
    const queue = [...targetHubs];

    const worker = async () => {
      while (queue.length > 0) {
        const hub = queue.shift();
        if (!hub) break;

        try {
          if (!this.fleetManager.isHubOnline(hub.id)) {
            failedCount++;
            this.store.updateBatchTaskProgress(taskId, {
              failed_nodes: failedCount,
              log_entry: { hub_id: hub.id, hub_name: hub.name, status: 'failed', error: 'Hub is offline', level: 'warn' }
            });
            continue;
          }

          // Execute matching command on hub
          const commandTimeout = options.commandTimeoutMs || 30000;
          const res = await this.fleetManager.sendCommand(hub.id, task.task_type, task.payload_json, commandTimeout);
          if (res.success) {
            successCount++;
            this.store.updateBatchTaskProgress(taskId, {
              successful_nodes: successCount,
              log_entry: { hub_id: hub.id, hub_name: hub.name, status: 'success', message: res.message || 'Success', level: 'info' }
            });
          } else {
            failedCount++;
            this.store.updateBatchTaskProgress(taskId, {
              failed_nodes: failedCount,
              log_entry: { hub_id: hub.id, hub_name: hub.name, status: 'failed', error: res.error || 'Execution failed', level: 'error' }
            });
          }
        } catch (err) {
          failedCount++;
          this.store.updateBatchTaskProgress(taskId, {
            failed_nodes: failedCount,
            log_entry: { hub_id: hub.id, hub_name: hub.name, status: 'failed', error: err.message, level: 'error' }
          });
        }
      }
    };

    const workerCount = Math.min(options.concurrency || 5, Math.max(1, total));
    const workers = [];
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }

    try {
      await Promise.all(workers);
      const finalStatus = failedCount === 0 ? 'completed' : (successCount > 0 ? 'completed' : 'failed');
      this.store.updateBatchTaskProgress(taskId, {
        status: finalStatus,
        successful_nodes: successCount,
        failed_nodes: failedCount,
        log_entry: { message: `Batch ${task.task_type} finished: ${successCount} succeeded, ${failedCount} failed`, level: 'info' }
      });
    } finally {
      this.runningTasks.delete(taskId);
    }

    return this.store.getBatchTask(taskId);
  }
}
