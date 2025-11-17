docker container rm -f backend
docker run \
-v $(pwd):/workspace \
--rm \
--ipc host \
--net host \
--name backend \
seisblue/eew \
/usr/local/bin/python /workspace/eew_backend.py
