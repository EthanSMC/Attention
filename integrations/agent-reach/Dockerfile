# Build only after approving the immutable Python base, upstream wheel and
# complete hashed runtime lock. No defaults deliberately: no moving image tags.
ARG PYTHON_BASE
FROM ${PYTHON_BASE}
ARG PYTHON_BASE
RUN python -c 'import os,re; assert re.fullmatch(r"[^@]+@sha256:[0-9a-f]{64}", os.environ["PYTHON_BASE"])'

# These two inputs are intentionally absent until the approved locking/build
# step. Build the original upstream wheel without patching package contents.
COPY requirements.lock /build/requirements.lock
COPY wheelhouse/ /build/wheelhouse/
RUN python -m pip install --no-index --require-hashes --no-cache-dir --find-links=/build/wheelhouse -r /build/requirements.lock \
    && rm -rf /build

WORKDIR /app
COPY worker.py /app/worker.py
USER 65532:65532
ENV PYTHONDONTWRITEBYTECODE=1
ENTRYPOINT ["python", "-I", "/app/worker.py"]
