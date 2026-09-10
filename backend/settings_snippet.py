# --- Add to your project's settings.py -----------------------------------------
# (or drop this app into the existing dev.jacksonbouffard.com Django project)

INSTALLED_APPS += [
    "rest_framework",
    "rest_framework.authtoken",
    "corsheaders",
    "trailapp_api",
]

MIDDLEWARE.insert(0, "corsheaders.middleware.CorsMiddleware")

# The static app is served from a different origin than the API, so CORS is
# required. List every origin the PWA is installed from — Safari treats
# jacksonbouffard.com and www.jacksonbouffard.com as different origins.
CORS_ALLOWED_ORIGINS = [
    "https://jacksonbouffard.com",
    "https://www.jacksonbouffard.com",
    "http://localhost:8080",
]
CORS_ALLOW_HEADERS = list(default_headers) + ["authorization"]  # from corsheaders.defaults

REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": ["rest_framework.authentication.TokenAuthentication"],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_RENDERER_CLASSES": ["rest_framework.renderers.JSONRenderer"],
    "DEFAULT_PAGINATION_CLASS": None,
}

# --- urls.py ------------------------------------------------------------------
# from django.urls import include, path
# urlpatterns += [path("trailapp/api/", include("trailapp_api.urls"))]
#
# With that prefix, the app's Settings → Server URL is
#   https://dev.jacksonbouffard.com/trailapp
# and the client appends /api/areas/ etc. itself.
