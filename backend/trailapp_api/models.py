"""
Server-side mirror of what the phone keeps in IndexedDB.

Design notes
- Primary keys are the client-generated UUID strings. The phone creates the
  record first and the server only ever mirrors it, so the client must own
  the id (otherwise a note saved offline would get a different id on sync).
- `updated_at` is *client* time, not auto_now. Sync is last-writer-wins on
  that timestamp, so the server must store what the client says rather than
  re-stamping it.
- Geometry is stored as GeoJSON in a JSONField. If this ever lives in the
  GeoDjango/PostGIS project instead, swap `geometry` for a PolygonField and
  keep the serializer emitting GeoJSON — the client doesn't care.
- Tiles are never uploaded. A SavedArea row is the recipe (footprint, zoom
  range, layers); the phone re-downloads tiles from the tile servers.
"""

from django.conf import settings
from django.db import models
from django.utils import timezone


class ClientOwned(models.Model):
    id = models.CharField(primary_key=True, max_length=64)
    owner = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(default=timezone.now, db_index=True)

    class Meta:
        abstract = True
        ordering = ["-updated_at"]


class SavedArea(ClientOwned):
    name = models.CharField(max_length=120)
    geometry = models.JSONField(help_text="GeoJSON Polygon or MultiPolygon")
    bounds = models.JSONField(help_text="{south, west, north, east}")
    zoom_min = models.PositiveSmallIntegerField(default=8)
    zoom_max = models.PositiveSmallIntegerField(default=15)
    margin_meters = models.PositiveIntegerField(default=0)
    layer_ids = models.JSONField(default=list, help_text="Basemap/overlay ids, e.g. ['opentopo','esri-hillshade']")
    tile_count = models.PositiveIntegerField(default=0)
    source = models.CharField(max_length=200, blank=True)

    def __str__(self):
        return f"{self.name} (z{self.zoom_min}-{self.zoom_max})"


class Annotation(ClientOwned):
    CATEGORIES = [("junction", "Junction"), ("hazard", "Hazard"), ("water", "Water"), ("camp", "Camp"), ("view", "View"), ("other", "Note")]
    lat = models.FloatField()
    lng = models.FloatField()
    title = models.CharField(max_length=120, blank=True)
    note = models.TextField(blank=True)
    category = models.CharField(max_length=16, choices=CATEGORIES, default="other")
    deleted = models.BooleanField(default=False, help_text="Soft delete so other devices learn about it on sync")

    def __str__(self):
        return self.title or self.category


class Track(ClientOwned):
    name = models.CharField(max_length=120, blank=True)
    started_at = models.DateTimeField(null=True, blank=True)
    points = models.JSONField(default=list, help_text="[{lat, lng, ts, ele}] breadcrumb points")

    def __str__(self):
        return self.name or self.id
