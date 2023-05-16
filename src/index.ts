/*************************************************************
 * Copyright (c) 2023 Heather Hosler.
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the
 * GNU General Public License as published by the Free Software Foundation,
 * either version 3 of the License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.
 * See the GNU General Public License for more details.
 *
 *
 * You should have received a copy of the GNU General Public License along with this program.
 * If not, see `https://www.gnu.org/licenses/`.
 */

import fs from "fs";
import * as dotenv from "dotenv";
import { Client, LogLevel } from "@notionhq/client";
import Bottleneck from "bottleneck";
import { promisify } from "util";
import { PageObjectResponse } from "@notionhq/client/build/src/api-endpoints";

dotenv.config();
const exec = promisify(require("node:child_process").exec);

// Read the environment variables

// If NOTION_SECRET is missing, exit with an error.
const notionSecret = process.env.NOTION_SECRET as string;
if (!notionSecret) {
  console.error(
    "No notion secret provided, please set the NOTION_SECRET environment variable."
  );
  process.exit(1);
}

// If USE_FFMPEG is missing, default to false.
const useFFmpeg: boolean = process.env.USE_FFMPEG == "true";

const notion = new Client({
  auth: notionSecret,
  logLevel: LogLevel.WARN,
});

// If INPUT_DATABASE or OUTPUT_DATABASE are missing, exit with an error.
const database_id = process.env.INPUT_DATABASE as string;
const output_db_id = process.env.OUTPUT_DATABASE as string;
if (!database_id || !output_db_id) {
  console.error(
    "Notion databases missing, please set both the INPUT_DATABASE and OUTPUT_DATABASE environment variables."
  );
  process.exit(1);
}

// DURATION_AS_MINUTES_WITH_SECONDS_IN_DECIMAL defaults to false, it is only included at special request of one user.
const useFalseMinuteFloatDuration: boolean =
  process.env.DURATION_AS_MINUTES_WITH_SECONDS_IN_DECIMAL == "true";

// Read crossfade length env variable but default to 1 if missing or incorrectly formatted
const crossfadeLength: number = (() => {
  const tempCrossfade = parseInt(process.env.CROSSFADE_LENGTH ?? "1");
  if (isNaN(tempCrossfade)) {
    return 1;
  } else {
    return tempCrossfade;
  }
})();

// Much of this requires sequential processing, use bottleneck to enforce this.
const limiter = new Bottleneck({ maxConcurrent: 1 });

// Convenience function to handle subtracting video timestamps, stored as arrays of numbers
const subtractTime = (startNumbers: number[], endNumbers: number[]) => {
  // Do the subtraction, long-hand
  let workingEndNumbers = JSON.parse(JSON.stringify(endNumbers));
  let durationNumbers: number[] = [0, 0, 0, 0];

  if (startNumbers.length == 3) {
    startNumbers.push(0);
  }

  if (endNumbers.length == 3) {
    endNumbers.push(0);
  }

  // Index 3 is tenths of a second
  if (workingEndNumbers[3] < startNumbers[3]) {
    // Carry one
    workingEndNumbers[2] = workingEndNumbers[2] - 1;
    workingEndNumbers[3] = workingEndNumbers[3] + 10;
  }
  durationNumbers[3] = workingEndNumbers[3] - startNumbers[3];
  if (workingEndNumbers[2] < startNumbers[2]) {
    // Carry one
    workingEndNumbers[1] = workingEndNumbers[1] - 1;
    workingEndNumbers[2] = workingEndNumbers[2] + 60;
  }
  durationNumbers[2] = workingEndNumbers[2] - startNumbers[2];
  if (workingEndNumbers[1] < startNumbers[1]) {
    // Carry one
    workingEndNumbers[0] = workingEndNumbers[0] - 1;
    workingEndNumbers[1] = workingEndNumbers[1] + 60;
  }
  durationNumbers[1] = workingEndNumbers[1] - startNumbers[1];
  durationNumbers[0] = workingEndNumbers[0] - startNumbers[0];

  return durationNumbers;
};

// Convenience function to handle parsing video timestamps, stored as strings
// It can handle timestamps with or without a decimal on the seconds.
const parseTime = (input: string) => {
  let timeArray = input.split(":");
  if (timeArray.length === 2) {
    timeArray = ["00", timeArray[0], timeArray[1], "00"];
  } else {
    timeArray = [timeArray[0], timeArray[1], timeArray[2], "00"];
  }
  if (/\./.test(timeArray[2])) {
    const parts = timeArray[2].split(".");
    timeArray = [timeArray[0], timeArray[1], parts[0], parts[1].slice(0, 1)];
  }

  // Start time goes [hours, minutes, seconds, tenths of a second]

  let timeNumbers: number[] = timeArray.map((digits: string) =>
    parseInt(digits)
  );

  return timeNumbers;
};

// Main process gets launched asynchronously, so it can handle the external ffmpeg processing, even though we enforce only one running at once.
(async () => {
  // Pull instructions from the input database.
  const instructions = await notion.databases.query({
    database_id,
    filter: { and: [{ property: "Processed", checkbox: { equals: false } }] },
  });

  let promiseList: Promise<any>[] = [];
  let recombineList: Record<string, any[]> = {};

  instructions.results.forEach((entry) => {
    promiseList.push(
      limiter.schedule(async (entry: any) => {
        // Read all the instructions from the Notion input database entry.
        const name =
          entry.properties["Input File Reference"].rich_text[0].plain_text;
        const outputBase =
          entry.properties["Output Base"].rich_text[0].plain_text;
        const inputFilename = `/working/Sources/${name}`;
        const startTimeString: string =
          entry.properties["In Timestamp"].rich_text[0].plain_text;
        const endTimeString =
          entry.properties["Out Timestamp"].rich_text[0].plain_text;
        const setCode =
          entry.properties["Set Code"].rollup.array[0].rich_text[0].plain_text;
        const setId = entry.properties["Set Reference"].relation[0].id;
        const orderString = entry.properties.Order.number.toString();
        const outputFormat = entry.properties["Format"].select.name;
        const nameParts = name.split(".");

        // Generated output filename, to output the temporary clip to.
        const outputFilename = `/working/Temp/${nameParts[0]}-${outputFormat}-${outputBase}-part${orderString}.${nameParts[1]}`;

        // Start & end times go [hours, minutes, seconds, tenths of a second]
        const startNumbers: number[] = parseTime(startTimeString);
        const endNumbers: number[] = parseTime(endTimeString);

        const durationNumbers: number[] = subtractTime(
          startNumbers,
          endNumbers
        );

        // Format the start time & duration as strings ffmpeg can intepret.
        const startString = `${startNumbers[0]
          .toString()
          .padStart(2, "0")}:${startNumbers[1]
          .toString()
          .padStart(2, "0")}:${startNumbers[2]
          .toString()
          .padStart(2, "0")}.${startNumbers[3].toString()}`;
        const durationString = `${durationNumbers[0]
          .toString()
          .padStart(2, "0")}:${durationNumbers[1]
          .toString()
          .padStart(2, "0")}:${durationNumbers[2]
          .toString()
          .padStart(2, "0")}.${durationNumbers[3].toString()}`;

        // Duration in seconds
        const duration =
          durationNumbers[0] * 3600 +
          durationNumbers[1] * 60 +
          durationNumbers[2];

        // Store full details of the temporary clip, for use when recombining.
        const details = {
          name,
          inputFilename,
          orderString,
          startNumbers,
          endNumbers,
          outputFilename,
          startString,
          outputBase,
          durationString,
          setCode,
          setId,
          typeCode:
            outputFormat == "Video" ? "V" : outputFormat === "GIF" ? "G" : "",
          outputFormat:
            outputFormat == "Video"
              ? "mp4"
              : outputFormat === "GIF"
              ? "gif"
              : "",
          durationNumbers,
          duration,
          page_id: entry.id,
        };

        const combinationCode = `${details.setCode}_${
          details.typeCode
        }_${outputBase.toString()}`;

        // Gathers all clips intended for the same final video together.
        if (!recombineList[combinationCode]) {
          recombineList[combinationCode] = [];
        }
        recombineList[combinationCode].push(details);

        // Some logging is good to keep an eye on how far the process through is, and figuring out what happened if anything goes wrong.
        console.log(details);

        // Have a switch primarily for testing, to skip full processing which takes a long time.
        if (!useFFmpeg) {
          return;
        }

        // Skip if the output file already exists to speed up restarting the process if necessary.
        if (!fs.existsSync(outputFilename)) {
          // Actually process the file through ffmpeg as an externally executed process.
          // Run ffmpeg with the start time before the input file, so it seeks quickly before parsing the video.
          await exec(
            `ffmpeg -y -ss ${startString} -i "${inputFilename}" -t ${durationString} "${outputFilename}"`
          );
        }
      }, entry as PageObjectResponse)
    );
  });

  // Process everything to temp midpoint clips first.
  await Promise.all(promiseList);
  console.log("All video clips extracted.");

  // Each final video needs cutting together with transitions.
  Object.entries(recombineList).forEach(
    ([combinationCode, detailsList]: [string, any[]]) => {
      promiseList.push(
        limiter.schedule(async (details: any[]) => {
          let inputString: string = "";
          let outputBase: string = "";
          let outputFormat: string = "";
          let setCode: string = "";
          let setId: string = "";
          let typeCode: string = "";
          let offsets: number[] = [];
          let cumulative: number = 0;
          let fadeEffectString: string = "";
          let audioFadeEffectString: string = "";
          let vStreamPrev: string = "[0:0]";
          let aStreamPrev: string = "[0:1]";

          // Sort the midway clips by order in the final video & build the command string for ffmpeg.
          details
            .sort((a, b) => parseInt(a.orderString) - parseInt(b.orderString))
            .forEach((detail, i) => {
              inputString = inputString + ` -i "${detail.outputFilename}" `;
              outputFormat = detail.outputFormat;
              outputBase = detail.outputBase;
              setCode = detail.setCode;
              setId = detail.setId;
              typeCode = detail.typeCode;
              offsets.push(cumulative + detail.duration - crossfadeLength - 1);
              cumulative += detail.duration - crossfadeLength - 1;

              let vStreamNext = `[v${i.toString()}]`;
              let aStreamNext = `[a${i.toString()}]`;
              if (i == 1) {
                fadeEffectString = fadeEffectString + ` -filter_complex "`;
              }
              if (i == details.length - 1) {
                vStreamNext = "";
                aStreamNext = "";
              }

              // Don't run the crossfade on the first clip.
              if (i >= 1) {
                fadeEffectString =
                  fadeEffectString +
                  `${vStreamPrev}[${i.toString()}:0]xfade=transition=fade:duration=${crossfadeLength}:offset=${
                    offsets[i - 1]
                  },format=yuv420p${vStreamNext};`;
                audioFadeEffectString =
                  audioFadeEffectString +
                  `${aStreamPrev}[${i.toString()}:1]acrossfade=d=${
                    crossfadeLength + 1
                  }:c1=tri:c2=tri${aStreamNext}`;
                vStreamPrev = vStreamNext;
                aStreamPrev = aStreamNext;
              }
              if (i != details.length - 1 && audioFadeEffectString.length > 1) {
                audioFadeEffectString = audioFadeEffectString + ";";
              }
            });
          if (fadeEffectString.length > 2) {
            fadeEffectString =
              fadeEffectString + `${audioFadeEffectString}" -vsync 0 `;
          }

          let outputBaseNumbers = outputBase.match(/\d+/)?.at(0) ?? "unknown";

          const outputFilename = `"/working/Finished/${setCode} ${typeCode}${outputBaseNumbers.padStart(
            3,
            "0"
          )}.${outputFormat}"`;

          if (outputFormat === "gif") {
            // Processing the gif is done as a 2 pass process, first to generate the custom palette, both decreasing the file size & greatly increasing the quality.
            const paletteName = `/working/Temp/${setCode}${typeCode}${outputBaseNumbers}.png`;
            const launchPalette = `ffmpeg -y ${inputString} -vf palettegen=256 "${paletteName}"`;
            console.log({ launchPalette });
            if (!useFFmpeg) {
              return;
            }
            await exec(launchPalette);

            // This will squash the gif to be inside a 1080 square, but keep the original aspect ratio.
            const launchString = `ffmpeg -y ${inputString} -i "${paletteName}" -filter_complex "fps=20,scale=1080:1080:force_original_aspect_ratio=decrease:flags=lanczos[x];[x][1:v]paletteuse" ${outputFilename}`;
            console.log({ launchString });
            if (!useFFmpeg) {
              return;
            }

            await exec(launchString);
          } else {
            // Process the final video by cutting each of the inputs together with the crossfade effects that have already been defined.
            const launchString = `ffmpeg -y ${inputString} ${fadeEffectString}${outputFilename}`;
            console.log({ launchString });
            if (!useFFmpeg) {
              return;
            }

            await exec(launchString);
          }

          // Inner promise list, so we can update each input entry as "processed" in Notion, and only after the final video has been generated without throwing an error.
          let innerPromiseList: Promise<any>[] = [];
          const innerLimiter = new Bottleneck({ maxConcurrent: 10 });
          details.forEach((detail) => {
            console.log({ detail });
            const page_id = detail.page_id;

            innerPromiseList.push(
              innerLimiter.schedule(async () => {
                await notion.pages.update({
                  page_id,
                  properties: { Processed: { checkbox: true } },
                });
              })
            );
          });

          // Run ffprobe to get an accurate duration for the output video.
          const outputDurationResponse = (
            await exec(`ffprobe -i ${outputFilename} -show_format`)
          ).stdout;
          const start = outputDurationResponse.indexOf("duration=", 0);
          const end = outputDurationResponse.indexOf("\n", start);
          const outputDurationString = outputDurationResponse.slice(
            start + 9,
            end
          );

          // Calculate the output duration, and alternatively format it with fake "minutes" as a float with seconds in the decimal.
          const outputDuration = (() => {
            const secondsDuration = parseFloat(outputDurationString);

            if (useFalseMinuteFloatDuration) {
              const minutes = Math.floor(secondsDuration / 60);
              const fakeSeconds =
                Math.floor(secondsDuration - minutes * 60) / 100; // Yes, divide by 100 to put the integer number of seconds into the first two decimal places!!
              const fakeTimeFloat = minutes + fakeSeconds;
              return fakeTimeFloat;
            } else {
              return secondsDuration;
            }
          })();
          const filenameInDatabase = outputFilename.slice(
            19,
            outputFilename.length - 5
          );

          // Build the properties for the Notion output entry of what we just created.
          const properties: any = {
            "File Name": {
              title: [
                {
                  text: {
                    content: filenameInDatabase,
                  },
                },
              ],
              type: "title",
            },
            Set: {
              type: "relation",
              relation: [{ id: setId }],
              has_more: false,
            },
            Format: {
              type: "select",
              select: {
                name:
                  outputFormat == "mp4"
                    ? "Video"
                    : outputFormat === "gif"
                    ? "GIF"
                    : "",
              },
            },
            Duration: { number: outputDuration, type: "number" },
          };

          // Upload the output media entry to the main database
          await notion.pages.create({
            parent: { type: "database_id", database_id: output_db_id },
            properties,
          });

          // Wait for everything to finish
          await Promise.all(innerPromiseList);
        }, detailsList)
      );
    }
  );

  // Same list because you can't await the same promise twice, it's already finished
  await Promise.all(promiseList);

  // Clean, successful exit.
  process.exit(0);
})();
