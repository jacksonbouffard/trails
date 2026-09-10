from rest_framework.routers import SimpleRouter

from .views import AnnotationViewSet, SavedAreaViewSet, TrackViewSet

router = SimpleRouter()
router.register("areas", SavedAreaViewSet, basename="area")
router.register("annotations", AnnotationViewSet, basename="annotation")
router.register("tracks", TrackViewSet, basename="track")

urlpatterns = router.urls
