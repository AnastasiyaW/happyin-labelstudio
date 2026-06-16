"""cars-mods (backend-fork 2026-06): backfill OK annotations saved WITHOUT the prediction's boxes.

The empty-OK bug (see tasks/cars_ok_boxes.py): an annotator marked a prediction OK but the
annotation was saved with no rectangle geometry, although the prediction HAD boxes. This command
finds those annotations in a cars project and fills in the prediction's boxes — the same logic the
pre_save signal now applies to new saves. Recoverable: the prediction is intact; this only adds
the geometry the OK approved.

  # see what would change (read-only)
  python label_studio/manage.py cars_fix_empty_ok_boxes --project 8 --dry-run
  # apply
  python label_studio/manage.py cars_fix_empty_ok_boxes --project 8

Idempotent: an annotation that already has boxes (or no OK, or whose prediction has no boxes) is
skipped, so re-running is safe.
"""

from __future__ import annotations

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from tasks.cars_ok_boxes import boxes_for_ok, has_ok_choice, has_rectangle
from tasks.models import Annotation


class Command(BaseCommand):
    help = "Fill prediction boxes into OK annotations saved without geometry (cars verify)."

    def add_arguments(self, parser):
        parser.add_argument('--project', type=int, required=True, help='Project id')
        parser.add_argument('--dry-run', action='store_true', help='Report only, write nothing')

    def handle(self, *args, **opts):
        pid = opts['project']
        dry = opts['dry_run']

        qs = (
            Annotation.objects.filter(task__project_id=pid, was_cancelled=False)
            .select_related('task')
            .only('id', 'result', 'task_id')
            .iterator(chunk_size=1000)
        )

        # Stage 1: candidates = OK verdict, no rectangle geometry.
        candidates = []
        scanned = 0
        for ann in qs:
            scanned += 1
            r = ann.result or []
            if has_rectangle(r) or not has_ok_choice(r):
                continue
            candidates.append(ann)

        self.stdout.write(f'project {pid}: scanned {scanned:,} annotations, {len(candidates)} OK-without-boxes')
        if not candidates:
            self.stdout.write(self.style.WARNING('nothing to fix'))
            return

        # Stage 2: for each, copy the prediction's boxes (skip if its prediction had none).
        fixed = no_pred_boxes = 0
        for ann in candidates:
            preds = [p.result for p in ann.task.predictions.all()]
            new_result = boxes_for_ok(ann.result, preds)
            if new_result is None:
                no_pred_boxes += 1
                continue
            if not dry:
                with transaction.atomic():
                    ann.result = new_result
                    ann.save(update_fields=['result', 'updated_at'])
            fixed += 1

        verb = 'would fill' if dry else 'filled'
        self.stdout.write(
            self.style.SUCCESS(
                f'{verb} {fixed} OK annotations with prediction boxes; '
                f'{no_pred_boxes} skipped (prediction had no boxes)'
            )
        )
