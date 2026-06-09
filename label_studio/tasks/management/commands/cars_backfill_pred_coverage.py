"""cars-mods (backend-fork 2026-06): backfill pre-annotation coverage into Task.meta.

For every task in a project that has predictions, compute the MAX single-region coverage
(fraction of the image the biggest pre-annotation occupies) and store it in
``Task.meta['cars_pred_coverage']`` (float 0..1). The DataManager grid reads this to put
tasks whose pre-annotation fills >= a threshold (default 70%) into a separate, collapsible
"big" section, away from the small pre-annotations.

No schema migration: ``meta`` is a stock JSONField on Task, already exposed to the grid via
``DataManagerTaskSerializer``. This command only writes the meta key; it never touches
predictions or annotations.

Usage (run on the LS host, inside the LS venv / container)::

    # jewelry first — dry run to see the distribution, then commit
    python label_studio/manage.py cars_backfill_pred_coverage --project 11 --dry-run
    python label_studio/manage.py cars_backfill_pred_coverage --project 11

    # later, after re-import, only fill tasks that don't have the value yet
    python label_studio/manage.py cars_backfill_pred_coverage --project 11 --only-missing

Idempotent: re-running recomputes and overwrites (unless --only-missing).
"""

from __future__ import annotations

from collections import Counter

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from data_manager.cars_coverage import result_max_coverage
from tasks.models import Prediction, Task

META_KEY = 'cars_pred_coverage'


class Command(BaseCommand):
    help = 'Backfill Task.meta[cars_pred_coverage] (max pre-annotation area fraction) for a project.'

    def add_arguments(self, parser):
        parser.add_argument('--project', type=int, required=True, help='Project id to backfill')
        parser.add_argument('--batch', type=int, default=500, help='Tasks per bulk_update (default 500)')
        parser.add_argument('--meta-key', default=META_KEY, help=f'Meta key to write (default {META_KEY})')
        parser.add_argument(
            '--only-missing',
            action='store_true',
            help='Skip tasks that already have the meta key (e.g. after a re-import)',
        )
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='Compute + print the distribution but do not write anything',
        )

    def handle(self, *args, **opts):
        project_id = opts['project']
        batch = max(1, opts['batch'])
        meta_key = opts['meta_key']
        only_missing = opts['only_missing']
        dry_run = opts['dry_run']

        if not Task.objects.filter(project_id=project_id).exists():
            raise CommandError(f'Project {project_id}: no tasks found')

        # 1. Max coverage per task across all of its predictions.
        #    Stream predictions (one project can have 100k+ tasks) and keep a running max.
        self.stdout.write(f'Project {project_id}: scanning predictions...')
        coverage_by_task: dict[int, float] = {}
        pred_qs = (
            Prediction.objects.filter(task__project_id=project_id)
            .values_list('task_id', 'result')
            .iterator(chunk_size=2000)
        )
        n_preds = 0
        for task_id, result in pred_qs:
            n_preds += 1
            c = result_max_coverage(result)
            prev = coverage_by_task.get(task_id)
            if prev is None or c > prev:
                coverage_by_task[task_id] = c

        n_tasks_with_pred = len(coverage_by_task)
        self.stdout.write(
            f'  predictions scanned: {n_preds:,}  tasks with predictions: {n_tasks_with_pred:,}'
        )
        if not coverage_by_task:
            self.stdout.write(self.style.WARNING('  nothing to do (no predictions)'))
            return

        # 2. Distribution histogram (10% bins) — quick sanity / threshold picking.
        buckets: Counter = Counter()
        for c in coverage_by_task.values():
            buckets[min(90, int(c * 10) * 10)] += 1
        self.stdout.write('  coverage distribution (% of image, 10% bins):')
        for b in sorted(buckets):
            cnt = buckets[b]
            bar = '#' * min(50, cnt // max(1, n_tasks_with_pred // 50 or 1))
            self.stdout.write(f'    {b:>3}-{b + 10:>3}%: {cnt:>8,}  {bar}')
        n_big = sum(1 for c in coverage_by_task.values() if c >= 0.70)
        self.stdout.write(f'  tasks with coverage >= 70%: {n_big:,}')

        if dry_run:
            self.stdout.write(self.style.WARNING('dry-run: no changes written'))
            return

        # 3. Write meta in batches. Only load tasks we have coverage for.
        task_ids = list(coverage_by_task.keys())
        written = skipped = 0
        for start in range(0, len(task_ids), batch):
            chunk_ids = task_ids[start : start + batch]
            with transaction.atomic():
                tasks = list(
                    Task.objects.filter(id__in=chunk_ids).select_for_update().only('id', 'meta')
                )
                to_update = []
                for t in tasks:
                    m = dict(t.meta or {})
                    if only_missing and meta_key in m:
                        skipped += 1
                        continue
                    m[meta_key] = round(coverage_by_task[t.id], 4)
                    t.meta = m
                    to_update.append(t)
                if to_update:
                    Task.objects.bulk_update(to_update, ['meta'])
                    written += len(to_update)
            self.stdout.write(f'  ...{min(start + batch, len(task_ids)):,}/{len(task_ids):,}')

        self.stdout.write(
            self.style.SUCCESS(f'done: wrote {written:,} tasks, skipped {skipped:,} (only-missing)')
        )
