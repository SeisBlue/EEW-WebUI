docker run -it --rm \
-v $(pwd):/workspace \
-w /workspace \
seisblue/eew \
/usr/local/bin/python $@