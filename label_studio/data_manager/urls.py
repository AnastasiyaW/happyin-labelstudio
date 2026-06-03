"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license."""

from data_manager import api, views
from django.urls import include, path
from rest_framework.routers import DefaultRouter

app_name = 'data_manager'
router = DefaultRouter()
router.register(r'views', api.ViewAPI, basename='view')

urlpatterns = [
    path('api/dm/', include((router.urls, app_name), namespace='api')),
    path('api/dm/columns/', api.ProjectColumnsAPI.as_view(), name='dm-columns'),
    path('api/dm/project/', api.ProjectStateAPI.as_view(), name='dm-project'),
    path('api/dm/actions/', api.ProjectActionsAPI.as_view(), name='dm-actions'),
    path('api/dm/actions/<str:action_id>/form/', api.ProjectActionsFormAPI.as_view(), name='dm-actions-form'),
    # cars-mods (backend-fork 2026-06): claim / release / mark-processed (Task.meta-based)
    path('api/dm/tasks/claim/', api.CarsClaimAPI.as_view(), name='cars-claim'),
    path('api/dm/tasks/release/', api.CarsReleaseAPI.as_view(), name='cars-release'),
    path('api/dm/tasks/<int:pk>/processed/', api.CarsProcessedAPI.as_view(), name='cars-processed'),
    # path("api/dm/tasks/", api.TaskListAPI.as_view()),
    # path("api/dm/tasks/<int:pk>", api.TaskAPI.as_view()),
    path('projects/<int:pk>/', views.task_page, name='project-data'),
    path('projects/<int:pk>/data/', views.task_page, name='project-data'),
    path('projects/<int:pk>/data/import', views.task_page, name='project-import'),
    path('projects/<int:pk>/data/export', views.task_page, name='project-export'),
]
