"""
Three tiny upsert endpoints. The phone talks to them like so:

    PUT    /api/areas/<uuid>/            create-or-replace (id comes from the URL)
    DELETE /api/areas/<uuid>/            hard delete
    GET    /api/areas/?updated_since=ISO everything changed since the last sync
    (same shape for /api/annotations/ and /api/tracks/; annotation DELETE is a
     soft delete so a second phone can drop its copy on the next sync)

Auth is DRF TokenAuthentication — one token per device, generated with
`manage.py drf_create_token <user>` and pasted into the app's Settings panel.
"""

from django.utils.dateparse import parse_datetime
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.authentication import TokenAuthentication
from rest_framework.response import Response

from .models import Annotation, SavedArea, Track
from .serializers import AnnotationSerializer, SavedAreaSerializer, TrackSerializer


class UpsertViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, mixins.DestroyModelMixin, viewsets.GenericViewSet):
    authentication_classes = [TokenAuthentication]
    permission_classes = [permissions.IsAuthenticated]
    soft_delete = False

    def get_queryset(self):
        qs = self.queryset.filter(owner=self.request.user)
        since = self.request.query_params.get("updated_since")
        if since:
            dt = parse_datetime(since)
            if dt is not None:
                qs = qs.filter(updated_at__gt=dt)
        if not since and hasattr(self.queryset.model, "deleted"):
            # A full pull needn't include tombstones; incremental pulls must.
            qs = qs.filter(deleted=False)
        return qs

    def update(self, request, pk=None):
        instance = self.queryset.filter(owner=request.user, pk=pk).first()
        serializer = self.get_serializer(instance, data=request.data)
        serializer.is_valid(raise_exception=True)
        serializer.save(owner=request.user, id=pk)
        return Response(serializer.data, status=status.HTTP_200_OK if instance else status.HTTP_201_CREATED)

    def destroy(self, request, pk=None):
        instance = self.queryset.filter(owner=request.user, pk=pk).first()
        if instance is None:
            return Response(status=status.HTTP_204_NO_CONTENT)
        if self.soft_delete:
            from django.utils import timezone

            instance.deleted = True
            instance.updated_at = timezone.now()
            instance.save(update_fields=["deleted", "updated_at"])
        else:
            instance.delete()
        return Response(status=status.HTTP_204_NO_CONTENT)


class SavedAreaViewSet(UpsertViewSet):
    queryset = SavedArea.objects.all()
    serializer_class = SavedAreaSerializer


class AnnotationViewSet(UpsertViewSet):
    queryset = Annotation.objects.all()
    serializer_class = AnnotationSerializer
    soft_delete = True


class TrackViewSet(UpsertViewSet):
    queryset = Track.objects.all()
    serializer_class = TrackSerializer
