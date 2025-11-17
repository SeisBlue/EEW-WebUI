docker run -it --rm \
--ipc host \
--net host \
-v $(pwd):/workspace \
-w /workspace \
seisblue/eew \
/usr/local/bin/python3 $@