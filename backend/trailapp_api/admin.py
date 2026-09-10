from django.contrib import admin

from .models import Annotation, SavedArea, Track


@admin.register(SavedArea)
class SavedAreaAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "zoom_min", "zoom_max", "tile_count", "updated_at")
    list_filter = ("owner",)


@admin.register(Annotation)
class AnnotationAdmin(admin.ModelAdmin):
    list_display = ("title", "category", "owner", "lat", "lng", "deleted", "updated_at")
    list_filter = ("category", "deleted", "owner")


@admin.register(Track)
class TrackAdmin(admin.ModelAdmin):
    list_display = ("name", "owner", "started_at", "updated_at")
