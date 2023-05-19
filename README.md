# Notion Video Editing with Docker

This project does video editing in batch by reading input instructions from a Notion database, processing the files in a Docker container and outputting records of the generated videos in another Notion database.

## Notion Databases Required

You will need to set up databases following exactly the structure of the examples on the help page: [Example Databases Page](https://tidal-kryptops-747.notion.site/Notion-Video-Editing-with-Docker-Guide-and-Examples-b739005a951a46bda7a8b98fe58f0921)

The Set database is used to group video editing together.
You can use this in any way you like, often it's one set per shoot, but it's important to group the videos together.

The Input Instructions database is where you define how you want the videos edited.
Each entry is a clip, defined by the input file reference & timestamps, then they get grouped by "Output Base", ordered by the "Order" and once put together, formatted using "Format".
The example on the page, creates a GIF from a single clip, and a Video (mp4) from two clips, from two source videos.

## Set Up Connections

You will first need to create a Notion app, from inside your Notion workspace.
This is important for you to be in control of the editing you do.
Once you have your NotionSecret, you will need to put it in your `.env` file.
Please be careful with this secret key, make sure you don't check the file into git.

Once you have everything set up in notion, you will need the database Id of your input and output databases.
This can be found using instructions on [Notion's Documentation](https://developers.notion.com/reference/retrieve-a-database).

## Running The System

Finally it will need a working folder, that must be set up as a shared volume accessible to the container.
This working folder must have the folders `Finished`, `Sources` and `Temp` inside it.
Place all source videos directly in the `Sources` folder.
The `Temp` folder is where each clip gets transferred to, ready to be put together in the final video.
We also use the `Temp` folder for the GIF pallette storage.
Finally, the `Finished` folder is where all of the composed videos are placed.
Each of these files will have an entry in the output database, so you can put them straight into your media storage, knowing that the metadata is already stored.

Example docker launch command for Windows:

```
docker run -v D:\\WindowsFolders\\SomePath\\Working:/working --rm process-videos
```

## Features

- 1s crossfade on video joins.
- High quality, low file size GIFs, (at 1080 max dimension).

## Help and Support

Bugs can be filed on the GitHub project, https://github.com/heatherhosler/notion-video-editing-docker/issues.
For individual support on a consultancy basis, please contact heather@thehoslers.com.

If you require a hosted solution, please contact heather@thehoslers.com to discuss your requirements.
