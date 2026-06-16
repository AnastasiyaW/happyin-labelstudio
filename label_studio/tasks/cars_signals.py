"""cars-mods (backend-fork 2026-06): pre_save signal that seeds OK annotations with the
prediction's boxes — fixes the CAUSE of the empty-OK bug at the source.

When an annotation is saved for a cars verify project (8/9/10) and it is an OK verdict with no
rectangle geometry, copy the task prediction's boxes into it (see tasks/cars_ok_boxes.py). This
runs in ``pre_save`` so it mutates ``instance.result`` BEFORE the row is written — no extra save,
no recursion. It only ADDS boxes to an OK that has none; WRONG / BAD_PHOTO and already-boxed
annotations are untouched (boxes_for_ok returns None), and non-cars projects exit immediately.

Connected from ``TasksConfig.ready()``.
"""

from __future__ import annotations

import logging

from django.db.models.signals import pre_save
from django.dispatch import receiver

from tasks.cars_ok_boxes import CARS_PROJECTS, boxes_for_ok

logger = logging.getLogger(__name__)


def connect():
    """Wire the pre_save receiver. Imported lazily (called from AppConfig.ready())."""
    from tasks.models import Annotation

    @receiver(pre_save, sender=Annotation, dispatch_uid='cars_seed_ok_boxes')
    def _cars_seed_ok_boxes(sender, instance, **kwargs):
        try:
            task = getattr(instance, 'task', None)
            if task is None or getattr(task, 'project_id', None) not in CARS_PROJECTS:
                return
            new_result = boxes_for_ok(instance.result, [p.result for p in task.predictions.all()])
            if new_result is not None:
                instance.result = new_result
                # Annotation.save() computes result_count from result BEFORE pre_save fires, so it
                # would be stale after we add boxes — recompute it here (runs before the DB write).
                try:
                    instance.result_count = len({r.get('id') for r in new_result if isinstance(r, dict)})
                except Exception:
                    pass
        except Exception:
            # never block an annotator's save because of this enhancement
            logger.exception('cars_seed_ok_boxes signal failed')
