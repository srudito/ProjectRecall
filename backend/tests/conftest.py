import os
import pytest
import requests

BASE_URL = os.environ.get('EXPO_PUBLIC_BACKEND_URL', '').rstrip('/')


@pytest.fixture(scope='session')
def base_url():
    assert BASE_URL, 'EXPO_PUBLIC_BACKEND_URL must be set in env'
    return BASE_URL


@pytest.fixture
def api_client():
    s = requests.Session()
    s.headers.update({'Content-Type': 'application/json'})
    return s
