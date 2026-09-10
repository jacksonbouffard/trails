"""
Field names are deliberately camelCase where the phone sends camelCase
(see js/backend.js → DjangoBackend.areaPayload / areaFromServer) and
snake_case for the two timestamps, matching what the client already emits.
"""

from rest_framework import serializers

from .models import Annotation, SavedArea, Track


class ClientOwnedSerializer(serializers.ModelSerializer):
    updated_at = serializers.DateTimeField()
    created_at = serializers.DateTimeField(required=False)

    def create(self, validated):
        # `owner` and `id` are injected by the view (see UpsertMixin).
        return super().create(validated)


class SavedAreaSerializer(ClientOwnedSerializer):
    zoomMin = serializers.IntegerField(source="zoom_min")
    zoomMax = serializers.IntegerField(source="zoom_max")
    marginMeters = serializers.IntegerField(source="margin_meters", required=False, default=0)
    layerIds = serializers.JSONField(source="layer_ids")
    tile_count = serializers.IntegerField(required=False, default=0)

    class Meta:
        model = SavedArea
        fields = ["id", "name", "geometry", "bounds", "zoomMin", "zoomMax", "marginMeters", "layerIds", "tile_count", "source", "created_at", "updated_at"]
        read_only_fields = ["id"]


class AnnotationSerializer(ClientOwnedSerializer):
    class Meta:
        model = Annotation
        fields = ["id", "lat", "lng", "title", "note", "category", "deleted", "created_at", "updated_at"]
        read_only_fields = ["id"]


class TrackSerializer(ClientOwnedSerializer):
    startedAt = serializers.DateTimeField(source="started_at", required=False, allow_null=True)

    class Meta:
        model = Track
        fields = ["id", "name", "startedAt", "points", "created_at", "updated_at"]
        read_only_fields = ["id"]
